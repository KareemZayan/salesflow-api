import { ApiProperty } from '@nestjs/swagger';

export class StageResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Proposal' }) name!: string;
  @ApiProperty({ example: 3, description: 'Board order, 1..n. Won and Lost are always last.' })
  position!: number;
  @ApiProperty({ example: 50, minimum: 0, maximum: 100 }) probability!: number;
  @ApiProperty() isWon!: boolean;
  @ApiProperty() isLost!: boolean;
}

export class PipelineResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Sales Pipeline' }) name!: string;
  @ApiProperty() isDefault!: boolean;
  @ApiProperty({ type: [StageResponseDto], description: 'In board order' })
  stages!: StageResponseDto[];
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
