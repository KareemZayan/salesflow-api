import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { OptionalButNotNull } from '../../../common/validators/optional-not-null.decorator';
import { ORGANIZATION_NAME_MAX_LENGTH } from '../../../common/policies/organization-policy';
import { IsCurrencyCode } from '../../../common/validators/is-currency-code.validator';

export class UpdateOrganizationDto {
  @ApiPropertyOptional({ maxLength: ORGANIZATION_NAME_MAX_LENGTH, example: 'Acme Corp' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(ORGANIZATION_NAME_MAX_LENGTH)
  @OptionalButNotNull()
  name?: string;

  @ApiPropertyOptional({
    example: 'EUR',
    description: 'ISO 4217 code; lowercase input is uppercased. Affects deals created afterwards.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsCurrencyCode()
  @OptionalButNotNull()
  defaultCurrency?: string;
}
