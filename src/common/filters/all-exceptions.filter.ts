import { STATUS_CODES } from 'node:http';
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '../../generated/prisma/client';
import { ERROR_CODES } from '../constants/error-codes';
import { ThrottleUnavailableException } from '../exceptions/throttle-unavailable.exception';
import { classifyDatabaseFailure, DatabaseFailure } from '../utils/database-failure.util';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string;
  code: string;
  details?: unknown;
}

const DEFAULT_CODE_BY_STATUS: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: ERROR_CODES.BAD_REQUEST,
  [HttpStatus.UNAUTHORIZED]: ERROR_CODES.UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: ERROR_CODES.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ERROR_CODES.RESOURCE_NOT_FOUND,
  [HttpStatus.CONFLICT]: ERROR_CODES.CONFLICT,
  [HttpStatus.TOO_MANY_REQUESTS]: ERROR_CODES.TOO_MANY_REQUESTS,
  [HttpStatus.SERVICE_UNAVAILABLE]: ERROR_CODES.SERVICE_UNAVAILABLE,
};

// Seconds a client is told to wait where waiting is the right answer (no free connection, database
// unreachable). Timeouts carry no hint: the same request may time out again. See ADR 0016.
const DATABASE_RETRY_AFTER_SECONDS = 2;

const DATABASE_FAILURE_RESPONSES: Record<
  DatabaseFailure,
  { status: HttpStatus; code: string; message: string; retryAfter: boolean }
> = {
  BUSY: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    code: ERROR_CODES.DATABASE_BUSY,
    message: 'The service is busy, please retry shortly',
    retryAfter: true,
  },
  TIMEOUT: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    code: ERROR_CODES.DATABASE_TIMEOUT,
    message: 'The operation took too long and was cancelled; nothing was changed',
    retryAfter: false,
  },
  WRITE_CONFLICT: {
    status: HttpStatus.CONFLICT,
    code: ERROR_CODES.WRITE_CONFLICT,
    message: 'The operation conflicted with a concurrent change and was rolled back; please retry',
    retryAfter: false,
  },
  UNAVAILABLE: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    code: ERROR_CODES.DATABASE_UNAVAILABLE,
    message: 'The service is temporarily unavailable',
    retryAfter: true,
  },
};

// The one place that decides what an error looks like on the wire. Stack traces and driver
// messages are logged, never returned.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: string }>();
    const response = http.getResponse<Response>();

    const failure = exception instanceof HttpException ? null : classifyDatabaseFailure(exception);
    const body = failure ? this.fromDatabaseFailure(failure) : this.toBody(exception);
    if (failure && DATABASE_FAILURE_RESPONSES[failure].retryAfter) {
      response.setHeader('Retry-After', String(DATABASE_RETRY_AFTER_SECONDS));
    }
    if (exception instanceof ThrottleUnavailableException) {
      response.setHeader('Retry-After', String(exception.retryAfterSeconds));
    }
    if (body.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }

    response.status(body.statusCode).json({
      ...body,
      path: request.originalUrl,
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  private toBody(exception: unknown): ErrorBody {
    if (exception instanceof HttpException) return this.fromHttpException(exception);
    if (exception instanceof Prisma.PrismaClientKnownRequestError)
      return this.fromPrisma(exception);
    return this.build(
      HttpStatus.INTERNAL_SERVER_ERROR,
      ERROR_CODES.INTERNAL_ERROR,
      'Internal server error',
    );
  }

  private fromDatabaseFailure(failure: DatabaseFailure): ErrorBody {
    const { status, code, message } = DATABASE_FAILURE_RESPONSES[failure];
    return this.build(status, code, message);
  }

  private fromHttpException(exception: HttpException): ErrorBody {
    const status = exception.getStatus();
    const response = exception.getResponse();
    const payload =
      typeof response === 'string' ? { message: response } : (response as Record<string, unknown>);
    const message = Array.isArray(payload.message) ? payload.message.join('; ') : payload.message;

    return this.build(
      status,
      typeof payload.code === 'string'
        ? payload.code
        : (DEFAULT_CODE_BY_STATUS[status] ??
            (status >= HttpStatus.INTERNAL_SERVER_ERROR
              ? ERROR_CODES.INTERNAL_ERROR
              : ERROR_CODES.BAD_REQUEST)),
      typeof message === 'string' ? message : exception.message,
      payload.details,
    );
  }

  private fromPrisma({ code }: Prisma.PrismaClientKnownRequestError): ErrorBody {
    switch (code) {
      case 'P2002':
        return this.build(
          HttpStatus.CONFLICT,
          ERROR_CODES.UNIQUE_CONSTRAINT_VIOLATION,
          'Resource already exists',
        );
      case 'P2025':
        return this.build(
          HttpStatus.NOT_FOUND,
          ERROR_CODES.RESOURCE_NOT_FOUND,
          'Resource not found',
        );
      case 'P2003':
        return this.build(
          HttpStatus.CONFLICT,
          ERROR_CODES.RELATED_RESOURCE_CONFLICT,
          'The operation conflicts with a related resource',
        );
      default:
        return this.build(
          HttpStatus.INTERNAL_SERVER_ERROR,
          ERROR_CODES.INTERNAL_ERROR,
          'Internal server error',
        );
    }
  }

  private build(statusCode: number, code: string, message: string, details?: unknown): ErrorBody {
    return {
      statusCode,
      error: STATUS_CODES[statusCode] ?? 'Error',
      message,
      code,
      ...(details === undefined ? {} : { details }),
    };
  }
}
