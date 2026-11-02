import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { MONEY_AMOUNT_PATTERN } from '../../../common/policies/money-policy';
import { trimString } from '../../../common/utils/string-transform.util';
import { IsCurrencyCode } from '../../../common/validators/is-currency-code.validator';
import { IsDateOnly } from '../../../common/validators/is-date-only.validator';
import { OptionalButNotNull } from '../../../common/validators/optional-not-null.decorator';
import { DEAL_TITLE_MAX_LENGTH } from '../deals.constants';
import { upperCaseCode } from './create-deal.dto';

// Stage and status are NOT here: they change only through POST /deals/:id/move (sending them is a
// 400). `title`, `amount`, `currency` and `ownerId` are NOT NULL columns; `contactId`, `companyId`
// and `expectedCloseDate` may be cleared with `null`.
export class UpdateDealDto {
  @ApiPropertyOptional({ maxLength: DEAL_TITLE_MAX_LENGTH })
  @OptionalButNotNull()
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(DEAL_TITLE_MAX_LENGTH)
  title?: string;

  @ApiPropertyOptional({ example: '12500.00', description: 'A decimal string; never null' })
  @OptionalButNotNull()
  @IsString()
  @Matches(MONEY_AMOUNT_PATTERN, { message: 'amount must be a decimal string such as "1250.50"' })
  amount?: string;

  @ApiPropertyOptional({ example: 'EUR', description: 'ISO 4217 code; never null' })
  @OptionalButNotNull()
  @Transform(upperCaseCode)
  @IsCurrencyCode()
  currency?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'A contact you can see; `null` unlinks',
  })
  @IsOptional()
  @IsUUID()
  contactId?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'A company you can see; `null` unlinks',
  })
  @IsOptional()
  @IsUUID()
  companyId?: string | null;

  @ApiPropertyOptional({ example: '2026-12-31', nullable: true, description: '`null` clears' })
  @IsOptional()
  @IsDateOnly()
  expectedCloseDate?: string | null;

  @ApiPropertyOptional({ format: 'uuid', description: 'Transfers the deal' })
  @OptionalButNotNull()
  @IsUUID()
  ownerId?: string;
}
