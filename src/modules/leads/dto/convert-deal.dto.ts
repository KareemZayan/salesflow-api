import { PickType } from '@nestjs/swagger';
import { CreateDealDto } from '../../deals/dto/create-deal.dto';

// The deal a conversion may create, described by the same fields (and the same validation) as
// POST /deals, minus the links and the owner: the deal is linked to the contact (and its company)
// the conversion produces and owned by the lead owner.
export class ConvertDealDto extends PickType(CreateDealDto, [
  'title',
  'amount',
  'currency',
  'pipelineId',
  'stageId',
  'expectedCloseDate',
] as const) {}
