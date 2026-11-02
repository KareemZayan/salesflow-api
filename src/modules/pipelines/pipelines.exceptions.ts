import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/exceptions/domain.exception';

export const pipelineNameTaken = () =>
  new DomainException(
    ERROR_CODES.PIPELINE_NAME_ALREADY_EXISTS,
    'A pipeline with this name already exists',
    HttpStatus.CONFLICT,
  );

export const stageNameTaken = () =>
  new DomainException(
    ERROR_CODES.STAGE_NAME_ALREADY_EXISTS,
    'A stage with this name already exists in the pipeline',
    HttpStatus.CONFLICT,
  );

export const pipelineIsDefault = () =>
  new DomainException(
    ERROR_CODES.PIPELINE_IS_DEFAULT,
    'The default pipeline cannot be deleted; make another pipeline the default first',
    HttpStatus.CONFLICT,
  );

// Soft-deleted deals count: the foreign keys are RESTRICT, so the database would refuse the delete.
export const pipelineHasDeals = () =>
  new DomainException(
    ERROR_CODES.PIPELINE_HAS_DEALS,
    'The pipeline has deals (deleted deals included) and cannot be deleted',
    HttpStatus.CONFLICT,
  );

export const stageInUse = () =>
  new DomainException(
    ERROR_CODES.STAGE_IN_USE,
    'The stage has deals or stage history (deleted deals included) and cannot be deleted',
    HttpStatus.CONFLICT,
  );

export const terminalStageRequired = () =>
  new DomainException(
    ERROR_CODES.TERMINAL_STAGE_REQUIRED,
    'The Won and Lost stages are required and cannot be deleted',
    HttpStatus.CONFLICT,
  );

export const pipelineNeedsOpenStage = () =>
  new DomainException(
    ERROR_CODES.PIPELINE_NEEDS_OPEN_STAGE,
    'A pipeline must keep at least one open stage',
    HttpStatus.CONFLICT,
  );

export const terminalProbabilityFixed = () =>
  new DomainException(
    ERROR_CODES.TERMINAL_STAGE_PROBABILITY_FIXED,
    'The probability of the Won and Lost stages is fixed',
    HttpStatus.BAD_REQUEST,
  );

export const invalidStageOrder = () =>
  new DomainException(
    ERROR_CODES.INVALID_STAGE_ORDER,
    'stageIds must list every open stage of the pipeline exactly once',
    HttpStatus.BAD_REQUEST,
  );

export const tooManyStages = () =>
  new DomainException(
    ERROR_CODES.TOO_MANY_STAGES,
    'A pipeline cannot have more open stages than the limit',
    HttpStatus.BAD_REQUEST,
  );

export const invalidPipeline = () =>
  new DomainException(
    ERROR_CODES.INVALID_PIPELINE,
    'The pipeline does not exist',
    HttpStatus.BAD_REQUEST,
  );

export const invalidStage = () =>
  new DomainException(
    ERROR_CODES.INVALID_STAGE,
    'The stage must be an open stage of the pipeline',
    HttpStatus.BAD_REQUEST,
  );
