import { Injectable } from '@nestjs/common';
import { RequestMetadataService } from '../../common/request-context/request-metadata.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { TenantTransactionClient } from '../../common/tenant/tenant-scope.extension';
import { Prisma } from '../../generated/prisma/client';
import { AUDIT_EVENT_DEFINITIONS, AuditEvent, isAuditEvent } from './audit-events';
import { AuditSnapshot, diffForAudit } from './audit-fields';

// Always a transaction client (`tx` of a $transaction callback), never the connection-level client:
// the audit row must commit or roll back together with the change it describes: the plain
// transaction client (auth runs before any tenant exists) or the tenant-scoped one.
// A type alone cannot refuse a PrismaService (a client has every member of its own transaction
// client), so `record` also refuses anything that has `$connect`: Prisma strips $connect,
// $disconnect, $on and $extends from the client it hands to a transaction callback, and a real
// client (plain or tenant-scoped) keeps them (tested against a real database).
export type AuditTransaction = Prisma.TransactionClient | TenantTransactionClient;

export interface AuditEntry {
  event: AuditEvent;
  entityId: string;
  // Snapshots of the allowlisted fields (audit-fields.ts). Only changed fields are stored.
  before?: AuditSnapshot;
  after?: AuditSnapshot;
}

// Who did it, when it is not the authenticated request: login and logout run before / without a
// tenant context, so the caller passes the user it LOADED from the database (never request input).
export interface AuditSubject {
  actorId: string;
  organizationId: string;
}

export class AuditRecordError extends Error {}

// Pattern: the one writer of AuditLog. Audit rows are written IN THE TRANSACTION of the audited
// change (fail-closed: if this throws, the business change rolls back), never through the queue
// (ADR 0014). Actor, organization, ip, user agent and request id come from the request context.
@Injectable()
export class AuditService {
  constructor(
    private readonly tenant: TenantContextService,
    private readonly requests: RequestMetadataService,
  ) {}

  // Returns false when there was nothing to record (an update that changed no audited field).
  async record(db: AuditTransaction, entry: AuditEntry, subject?: AuditSubject): Promise<boolean> {
    if (!isAuditEvent(entry.event)) {
      throw new AuditRecordError(`Unknown audit event: ${String(entry.event)}`);
    }
    if ('$connect' in (db as object)) {
      throw new AuditRecordError('AuditService.record needs a transaction client, not a client');
    }

    const { organizationId, actorId } = this.resolveWho(subject);
    const diff = diffForAudit(
      AUDIT_EVENT_DEFINITIONS[entry.event].entityType,
      entry.before,
      entry.after,
    );
    if (!diff) return false;

    const { ipAddress, userAgent, requestId } = this.requests.get();
    // Both members of the union have the same `auditLog.create`; a union of generic methods is not callable.
    await (db as Pick<Prisma.TransactionClient, 'auditLog'>).auditLog.create({
      data: {
        organizationId,
        actorId,
        action: AUDIT_EVENT_DEFINITIONS[entry.event].action,
        event: entry.event,
        entityType: AUDIT_EVENT_DEFINITIONS[entry.event].entityType,
        entityId: entry.entityId,
        before: diff.before ?? undefined,
        after: diff.after ?? undefined,
        ipAddress,
        userAgent,
        requestId,
      },
    });
    return true;
  }

  // An explicit subject must agree with the tenant context when there is one: a row can never be
  // written for another organization than the one the request or job runs in.
  private resolveWho(subject?: AuditSubject): { organizationId: string; actorId: string | null } {
    const contextOrganizationId = this.tenant.organizationId;
    if (subject) {
      if (contextOrganizationId && contextOrganizationId !== subject.organizationId) {
        throw new AuditRecordError('Audit subject belongs to another organization');
      }
      return subject;
    }
    if (!contextOrganizationId) throw new AuditRecordError('No tenant context for the audit row');
    return { organizationId: contextOrganizationId, actorId: this.tenant.userId ?? null };
  }
}
