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

// The one place that decides what an error looks like on the wire. Stack traces and driver
// messages are logged, never returned.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: string }>();
    const response = http.getResponse<Response>();

    const body = this.toBody(exception);
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
