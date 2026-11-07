import { Injectable } from '@nestjs/common';
import { ClsService, ClsStore } from 'nestjs-cls';

export const HTTP_REQUEST_KEY = 'httpRequest';
export const MAX_USER_AGENT_LENGTH = 512;

// The slice of the HTTP request that is audited (nothing else of the request is kept).
export interface RequestLike {
  ip?: string;
  id?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

export interface RequestMetadata {
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
}

interface RequestStore extends ClsStore {
  [HTTP_REQUEST_KEY]?: RequestLike;
}

// Where the request came from, for the audit trail. The request is put in the CLS context by the
// middleware in CommonModule and read LAZILY here: the request id is assigned by the logger
// middleware, which may run after the CLS one. Jobs and scripts have no request: all null.
@Injectable()
export class RequestMetadataService {
  constructor(private readonly cls: ClsService<RequestStore>) {}

  get(): RequestMetadata {
    const request = this.cls.isActive() ? this.cls.get(HTTP_REQUEST_KEY) : undefined;
    if (!request) return { ipAddress: null, userAgent: null, requestId: null };
    const userAgent = request.headers['user-agent'];
    return {
      ipAddress: request.ip ?? null,
      userAgent: typeof userAgent === 'string' ? userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null,
      requestId: typeof request.id === 'string' ? request.id : null,
    };
  }
}
