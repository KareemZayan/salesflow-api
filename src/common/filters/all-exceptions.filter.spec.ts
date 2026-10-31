import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { ValidationError } from 'class-validator';
import { Prisma } from '../../generated/prisma/client';
import { ERROR_CODES } from '../constants/error-codes';
import { DomainException } from '../exceptions/domain.exception';
import { validationExceptionFactory } from '../pipes/validation-exception.factory';
import { AllExceptionsFilter } from './all-exceptions.filter';

class LeadAlreadyConvertedException extends DomainException {
  constructor() {
    super('LEAD_ALREADY_CONVERTED', 'Lead is already converted', HttpStatus.CONFLICT);
  }
}

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('driver detail: secret_table', {
    code,
    clientVersion: 'test',
  });

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  function run(exception: unknown) {
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ originalUrl: '/api/v1/leads', id: 'req-1' }),
        getResponse: () => ({ status }),
      }),
    } as unknown as ArgumentsHost;
    vi.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
    filter.catch(exception, host);
    return { status: status.mock.calls[0][0] as number, body: json.mock.calls[0][0] };
  }

  it('returns the standard shape with path, timestamp and requestId', () => {
    const { status, body } = run(new NotFoundException('Lead not found'));
    expect(status).toBe(404);
    expect(body).toMatchObject({
      statusCode: 404,
      error: 'Not Found',
      message: 'Lead not found',
      code: ERROR_CODES.RESOURCE_NOT_FOUND,
      path: '/api/v1/leads',
      requestId: 'req-1',
    });
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it('uses the code of a domain exception', () => {
    const { status, body } = run(new LeadAlreadyConvertedException());
    expect(status).toBe(409);
    expect(body).toMatchObject({
      code: 'LEAD_ALREADY_CONVERTED',
      message: 'Lead is already converted',
    });
  });

  it('falls back to a status-based code for plain HttpExceptions', () => {
    expect(run(new ConflictException('x')).body.code).toBe(ERROR_CODES.CONFLICT);
    expect(run(new BadRequestException(['a', 'b'])).body).toMatchObject({
      code: ERROR_CODES.BAD_REQUEST,
      message: 'a; b',
    });
  });

  it('reports validation failures per field', () => {
    const errors = [
      { property: 'email', constraints: { isEmail: 'email must be an email' } },
      {
        property: 'address',
        children: [{ property: 'city', constraints: { isString: 'city must be a string' } }],
      },
    ] as ValidationError[];
    const { status, body } = run(validationExceptionFactory(errors));
    expect(status).toBe(400);
    expect(body).toMatchObject({
      code: ERROR_CODES.VALIDATION_FAILED,
      details: [
        { field: 'email', messages: ['email must be an email'] },
        { field: 'address.city', messages: ['city must be a string'] },
      ],
    });
  });

  it.each([
    ['P2002', 409, ERROR_CODES.UNIQUE_CONSTRAINT_VIOLATION],
    ['P2025', 404, ERROR_CODES.RESOURCE_NOT_FOUND],
    ['P2003', 409, ERROR_CODES.RELATED_RESOURCE_CONFLICT],
  ])(
    'maps Prisma %s to %i without leaking driver details',
    (code, expectedStatus, expectedCode) => {
      const { status, body } = run(prismaError(code));
      expect(status).toBe(expectedStatus);
      expect(body.code).toBe(expectedCode);
      expect(JSON.stringify(body)).not.toContain('secret_table');
    },
  );

  it('hides unknown errors behind a generic 500', () => {
    const { status, body } = run(new Error('db password is hunter2'));
    expect(status).toBe(500);
    expect(body).toMatchObject({
      code: ERROR_CODES.INTERNAL_ERROR,
      message: 'Internal server error',
    });
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(body).not.toHaveProperty('stack');
  });

  it('treats an unmapped Prisma code as a 500', () => {
    expect(run(prismaError('P9999')).status).toBe(500);
  });
});
