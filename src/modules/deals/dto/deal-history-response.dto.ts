import { ApiProperty } from '@nestjs/swagger';

export class StageRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Proposal' }) name!: string;
}

export class DealHistoryResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    type: StageRefDto,
    nullable: true,
    description: 'Null for the first placement of a new deal',
  })
  fromStage!: StageRefDto | null;
  @ApiProperty({ type: StageRefDto }) toStage!: StageRefDto;
  @ApiProperty({ format: 'uuid', description: 'The user who made the change' })
  changedById!: string;
  @ApiProperty() changedAt!: Date;
}
