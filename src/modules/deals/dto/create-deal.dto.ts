import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { MONEY_AMOUNT_PATTERN } from '../../../common/policies/money-policy';
import { trimString } from '../../../common/utils/string-transform.util';
import { IsCurrencyCode } from '../../../common/validators/is-currency-code.validator';
import { IsDateOnly } from '../../../common/validators/is-date-only.validator';
import { OptionalButNotNull } from '../../../common/validators/optional-not-null.decorator';
import { DEAL_TITLE_MAX_LENGTH } from '../deals.constants';

export const upperCaseCode = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class CreateDealDto {
  @ApiProperty({ example: 'Globex annual licence', maxLength: DEAL_TITLE_MAX_LENGTH })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(DEAL_TITLE_MAX_LENGTH)
  title!: string;

  @ApiPropertyOptional({
    example: '12500.00',
    description:
      'A decimal STRING with up to 12 digits and 2 decimals (a JSON number is rejected). Optional: ' +
      'defaults to "0.00". Zero is allowed; the amount is never null.',
  })
  @OptionalButNotNull()
  @IsString()
  @Matches(MONEY_AMOUNT_PATTERN, { message: 'amount must be a decimal string such as "1250.50"' })
  amount?: string;

  @ApiPropertyOptional({
    example: 'USD',
    description: 'ISO 4217 code. Defaults to the organization currency. No conversion.',
  })
  @OptionalButNotNull()
  @Transform(upperCaseCode)
  @IsCurrencyCode()
  currency?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Defaults to the default pipeline of the organization',
  })
  @OptionalButNotNull()
  @IsUUID()
  pipelineId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'An OPEN stage of the pipeline. Defaults to its first open stage.',
  })
  @OptionalButNotNull()
  @IsUUID()
  stageId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'A contact you can see' })
  @OptionalButNotNull()
  @IsUUID()
  contactId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'A company you can see' })
  @OptionalButNotNull()
  @IsUUID()
  companyId?: string;

  @ApiPropertyOptional({ example: '2026-12-31', description: 'A calendar date, YYYY-MM-DD' })
  @OptionalButNotNull()
  @IsDateOnly()
  expectedCloseDate?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Defaults to you' })
  @OptionalButNotNull()
  @IsUUID()
  ownerId?: string;
}
