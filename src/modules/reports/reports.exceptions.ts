import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/exceptions/domain.exception';

export const invalidReportRange = (message: string): DomainException =>
  new DomainException(ERROR_CODES.INVALID_REPORT_RANGE, message, HttpStatus.BAD_REQUEST);
