import { Injectable } from '@nestjs/common';
import { CursorPaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { decodeKeysetCursor, encodeKeysetCursor } from '../../common/utils/keyset-cursor.util';
import { buildCursorPage } from '../../common/utils/pagination.util';
import { instantToDate } from '../../common/validators/is-instant.validator';
import {
  AUDIT_RETENTION_BATCH_SIZE,
  AUDIT_RETENTION_DAYS,
  AUDIT_RETENTION_MAX_BATCHES,
} from './audit-logs.constants';
import { AuditLogsRepository } from './audit-logs.repository';
import { AuditLogResponseDto } from './dto/audit-log-response.dto';
import { ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AuditLogsService {
  constructor(private readonly repository: AuditLogsRepository) {}

  // Reading the audit log is deliberately NOT audited (it would write a row per page view).
  async list(
    actor: AuthenticatedUser,
    { cursor, limit, from, to, ...filters }: ListAuditLogsQueryDto,
  ): Promise<CursorPaginatedResponseDto<AuditLogResponseDto>> {
    const after = cursor ? decodeKeysetCursor(cursor, actor.organizationId) : undefined;
    const rows = await this.repository.findPage(
      {
        ...filters,
        from: from ? instantToDate(from) : undefined,
        to: to ? instantToDate(to) : undefined,
      },
      after,
      limit + 1,
    );
    return buildCursorPage(rows, limit, (last) =>
      encodeKeysetCursor(actor.organizationId, { at: last.createdAt, id: last.id }),
    );
  }

  // Retention job: PERMANENTLY removes this organization's rows older than the retention period
  // (tenant from the job context) and returns how many. Bounded per run; the next daily run continues.
  purgeExpired(now: Date): Promise<number> {
    return this.repository.purgeOlderThan(
      new Date(now.getTime() - AUDIT_RETENTION_DAYS * DAY_MS),
      AUDIT_RETENTION_BATCH_SIZE,
      AUDIT_RETENTION_MAX_BATCHES,
    );
  }
}
