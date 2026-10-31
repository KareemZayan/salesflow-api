import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

// Global: every feature repository needs it, and it holds no business logic.
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
