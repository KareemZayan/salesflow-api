import {
  applyDecorators,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiCursorPaginatedResponse } from '../../common/decorators/api-cursor-paginated-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { CursorQueryDto } from '../../common/dto/cursor-query.dto';
import { CursorPaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { ActivitiesService } from './activities.service';
import { ActivityParentKind } from './activity-parent';
import { ActivityResponseDto } from './dto/activity-response.dto';
import { CreateActivityDto } from './dto/create-activity.dto';

const listDocs = (record: string) =>
  applyDecorators(
    ApiOperation({
      summary: `The timeline of a ${record}`,
      description:
        `Newest first. Automatic entries come from events (statuses, stage moves, conversion, ` +
        `assignment); manual ones are calls, emails, meetings and notes. Cursor pagination: ` +
        `append-heavy table, so pages stay stable while entries are added. Pass \`meta.nextCursor\` ` +
        `back as \`cursor\`. Deal details on this timeline appear only for deals you can see.`,
    }),
    ApiCursorPaginatedResponse(ActivityResponseDto),
    ApiBadRequestResponse({ description: 'VALIDATION_FAILED or INVALID_CURSOR' }),
    ApiForbiddenResponse({ description: `FORBIDDEN (needs activities:read and ${record}s:read)` }),
    ApiNotFoundResponse({
      description: `RESOURCE_NOT_FOUND (also when the ${record} is another organization or not yours)`,
    }),
  );

const createDocs = (record: string) =>
  applyDecorators(
    ApiOperation({
      summary: `Log a call, email, meeting or note on a ${record}`,
      description:
        'The text is visible to everyone who can see the record. It is trimmed and length limited, ' +
        'and the server never logs it.',
    }),
    ApiCreatedResponse({ type: ActivityResponseDto }),
    ApiBadRequestResponse({ description: 'VALIDATION_FAILED' }),
    ApiForbiddenResponse({
      description: `FORBIDDEN (needs activities:create and ${record}s:read)`,
    }),
    ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND' }),
  );

type Timeline = Promise<CursorPaginatedResponseDto<ActivityResponseDto>>;

// HTTP only: pick the parent kind, delegate. Who may see what is the service's job.
@ApiTags('Activities')
@ApiBearerAuth()
@Controller()
export class ActivitiesController {
  constructor(private readonly activities: ActivitiesService) {}

  private list(
    actor: AuthenticatedUser,
    kind: ActivityParentKind,
    id: string,
    q: CursorQueryDto,
  ): Timeline {
    return this.activities.list(actor, { kind, id }, q);
  }

  private create(
    actor: AuthenticatedUser,
    kind: ActivityParentKind,
    id: string,
    dto: CreateActivityDto,
  ): Promise<ActivityResponseDto> {
    return this.activities.createManual(actor, { kind, id }, dto);
  }

  @Get('leads/:id/activities')
  @Permissions('activities:read', 'leads:read')
  @listDocs('lead')
  listForLead(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
    @Query() q: CursorQueryDto,
  ): Timeline {
    return this.list(actor, 'lead', id, q);
  }

  @Get('deals/:id/activities')
  @Permissions('activities:read', 'deals:read')
  @listDocs('deal')
  listForDeal(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
    @Query() q: CursorQueryDto,
  ): Timeline {
    return this.list(actor, 'deal', id, q);
  }

  @Get('contacts/:id/activities')
  @Permissions('activities:read', 'contacts:read')
  @listDocs('contact')
  listForContact(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
    @Query() q: CursorQueryDto,
  ): Timeline {
    return this.list(actor, 'contact', id, q);
  }

  @Get('companies/:id/activities')
  @Permissions('activities:read', 'companies:read')
  @listDocs('company')
  listForCompany(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
    @Query() q: CursorQueryDto,
  ): Timeline {
    return this.list(actor, 'company', id, q);
  }

  @Post('leads/:id/activities')
  @Permissions('activities:create', 'leads:read')
  @createDocs('lead')
  createForLead(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
    @Body() dto: CreateActivityDto,
  ) {
    return this.create(actor, 'lead', id, dto);
  }

  @Post('deals/:id/activities')
  @Permissions('activities:create', 'deals:read')
  @createDocs('deal')
  createForDeal(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
    @Body() dto: CreateActivityDto,
  ) {
    return this.create(actor, 'deal', id, dto);
  }

  @Post('contacts/:id/activities')
  @Permissions('activities:create', 'contacts:read')
  @createDocs('contact')
  createForContact(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
    @Body() dto: CreateActivityDto,
  ) {
    return this.create(actor, 'contact', id, dto);
  }

  @Post('companies/:id/activities')
  @Permissions('activities:create', 'companies:read')
  @createDocs('company')
  createForCompany(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
    @Body() dto: CreateActivityDto,
  ) {
    return this.create(actor, 'company', id, dto);
  }

  // There is no activities:delete permission: deleting is part of logging (you fix your own entry),
  // and the author / admin rule is enforced by the service.
  @Delete('activities/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions('activities:create')
  @ApiOperation({
    summary: 'Delete a manual timeline entry',
    description:
      'The author, while they can still see the record, or an admin. System entries (statuses, ' +
      'stage moves, conversion, assignment) are immutable. There is no edit endpoint.',
  })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({
    description:
      "FORBIDDEN, or ACTIVITY_DELETE_RESTRICTED (someone else's entry, you are not admin)",
  })
  @ApiNotFoundResponse({
    description: 'RESOURCE_NOT_FOUND (also when the record it hangs on is not yours to see)',
  })
  @ApiConflictResponse({ description: 'ACTIVITY_IMMUTABLE (a system entry)' })
  delete(@CurrentUser() actor: AuthenticatedUser, @Param() { id }: IdParamDto): Promise<void> {
    return this.activities.delete(actor, id);
  }
}
