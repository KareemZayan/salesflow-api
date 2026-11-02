import { Module } from '@nestjs/common';
import { PipelinesController } from './pipelines.controller';
import { PipelinesRepository } from './pipelines.repository';
import { PipelinesService } from './pipelines.service';

@Module({
  controllers: [PipelinesController],
  providers: [PipelinesService, PipelinesRepository],
  exports: [PipelinesService],
})
export class PipelinesModule {}
