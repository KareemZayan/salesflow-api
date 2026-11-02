import { MONEY_DECIMALS } from '../../common/policies/money-policy';
import { DealRecord } from './deals.repository';
import { DealResponseDto } from './dto/deal-response.dto';

// The one place a deal record becomes its API shape: money as a decimal STRING with fixed decimals
// (never a float), the close date as a plain YYYY-MM-DD.
export function toDealResponse(deal: DealRecord): DealResponseDto {
  return {
    ...deal,
    amount: deal.amount.toFixed(MONEY_DECIMALS),
    expectedCloseDate: deal.expectedCloseDate?.toISOString().slice(0, 10) ?? null,
  };
}
