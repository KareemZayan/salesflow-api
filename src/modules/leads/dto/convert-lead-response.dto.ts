import { ApiProperty } from '@nestjs/swagger';
import { CompanyResponseDto } from '../../companies/dto/company-response.dto';
import { DealResponseDto } from '../../deals/dto/deal-response.dto';
import { ContactResponseDto } from '../../contacts/dto/contact-response.dto';
import { LeadResponseDto } from './lead-response.dto';

export class ConvertLeadResponseDto {
  @ApiProperty({ type: LeadResponseDto }) lead!: LeadResponseDto;

  @ApiProperty({
    type: ContactResponseDto,
    description: 'The contact that was created, or the existing one that was linked',
  })
  contact!: ContactResponseDto;

  @ApiProperty({
    type: CompanyResponseDto,
    nullable: true,
    description:
      'Set only when `createCompany` created a company. A linked company shows in `contact.companyId`.',
  })
  createdCompany!: CompanyResponseDto | null;

  @ApiProperty({
    type: DealResponseDto,
    nullable: true,
    description: 'Set only when the request asked for a deal',
  })
  deal!: DealResponseDto | null;
}
