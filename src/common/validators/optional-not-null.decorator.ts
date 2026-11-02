import { ValidateIf } from 'class-validator';

// For PATCH fields that may be left out but must never be sent as `null`. class-validator's own
// @IsOptional() also accepts null, which would reach Prisma and surface as a 500 for a column that
// is NOT NULL. (Fields that may legitimately be cleared, like managerId, keep @IsOptional().)
export const OptionalButNotNull = (): PropertyDecorator =>
  ValidateIf((_object: unknown, value: unknown) => value !== undefined);
