import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiCursorPaginatedResponse } from '../../common/decorators/api-cursor-paginated-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { CursorPaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { AuditLogsService } from './audit-logs.service';
import { AuditLogResponseDto } from './dto/audit-log-response.dto';
import { ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto';

@ApiTags('Audit logs')
@ApiBearerAuth()
@Controller('audit-logs')
export class AuditLogsController {
  constructor(private readonly auditLogs: AuditLogsService) {}

  @Get()
  @Permissions('audit-logs:read')
  @ApiOperation({
    summary: 'Who changed what, and when (your organization only)',
    description:
      'Newest first. Cursor pagination, no total count: the table is append-only and large, so ' +
      'pages stay stable while rows are added. Pass `meta.nextCursor` back as `cursor`. ' +
      'Administrators only. The response includes `ipAddress` and `userAgent` (personal data); no ' +
      'other endpoint exposes them. Reading the audit log is not itself audited.',
  })
  @ApiCursorPaginatedResponse(AuditLogResponseDto)
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED or INVALID_CURSOR' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (needs audit-logs:read)' })
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListAuditLogsQueryDto,
  ): Promise<CursorPaginatedResponseDto<AuditLogResponseDto>> {
    return this.auditLogs.list(actor, query);
  }
}
