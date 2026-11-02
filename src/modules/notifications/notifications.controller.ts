import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiPaginatedResponse } from '../../common/decorators/api-paginated-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import {
  MarkAllReadResponseDto,
  NotificationResponseDto,
  UnreadCountResponseDto,
} from './dto/notification-response.dto';
import { NotificationsService } from './notifications.service';

// No @Permissions: a notification is addressed to one user, and every route below only ever
// touches the caller's own. Admins have no way to read someone else's inbox through this API.
@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({
    summary: 'List your notifications, newest first',
    description: 'Offset pagination. `unread=true` returns only the ones you have not read.',
  })
  @ApiPaginatedResponse(NotificationResponseDto)
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED or INVALID_SORT_FIELD' })
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<PaginatedResponseDto<NotificationResponseDto>> {
    return this.notifications.list(actor, query);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'How many notifications you have not read yet' })
  @ApiOkResponse({ type: UnreadCountResponseDto })
  unreadCount(@CurrentUser() actor: AuthenticatedUser): Promise<UnreadCountResponseDto> {
    return this.notifications.unreadCount(actor);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark all your notifications as read',
    description: 'Idempotent: repeating it returns `updated: 0`.',
  })
  @ApiOkResponse({ type: MarkAllReadResponseDto })
  markAllRead(@CurrentUser() actor: AuthenticatedUser): Promise<MarkAllReadResponseDto> {
    return this.notifications.markAllRead(actor);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark one notification as read',
    description: 'Idempotent: an already-read notification keeps its first `readAt`.',
  })
  @ApiOkResponse({ type: NotificationResponseDto })
  @ApiNotFoundResponse({
    description: 'RESOURCE_NOT_FOUND (also when it is another user or organization)',
  })
  markRead(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
  ): Promise<NotificationResponseDto> {
    return this.notifications.markRead(actor, id);
  }
}
