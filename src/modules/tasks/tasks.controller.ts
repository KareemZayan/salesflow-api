import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiPaginatedResponse } from '../../common/decorators/api-paginated-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { ChangeTaskStatusDto } from './dto/change-task-status.dto';
import { CreateTaskDto } from './dto/create-task.dto';
import { ListTasksQueryDto } from './dto/list-tasks-query.dto';
import { TaskResponseDto } from './dto/task-response.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { TasksService } from './tasks.service';

@ApiTags('Tasks')
@ApiBearerAuth()
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  @Permissions('tasks:read')
  @ApiOperation({
    summary: 'List the tasks you may see',
    description:
      'Visibility follows the ASSIGNEE: admins see the whole organization, managers the tasks ' +
      'assigned to them and their team, everyone else only their own. Every filter narrows the ' +
      'list; none widens it. `overdue=true` returns open tasks due before now. Sorting by ' +
      '`dueDate` puts tasks without one last (asc) or first (desc). Offset pagination.',
  })
  @ApiPaginatedResponse(TaskResponseDto)
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED or INVALID_SORT_FIELD' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing tasks:read)' })
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListTasksQueryDto,
  ): Promise<PaginatedResponseDto<TaskResponseDto>> {
    return this.tasks.list(actor, query);
  }

  @Get(':id')
  @Permissions('tasks:read')
  @ApiOperation({ summary: 'Get one task' })
  @ApiOkResponse({ type: TaskResponseDto })
  @ApiNotFoundResponse({
    description: 'RESOURCE_NOT_FOUND (also when it is another organization or not yours to see)',
  })
  get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
  ): Promise<TaskResponseDto> {
    return this.tasks.get(actor, id);
  }

  @Post()
  @Permissions('tasks:create')
  @ApiOperation({
    summary: 'Create a task',
    description:
      'The assignee defaults to you; reps can only assign to themselves, managers within their ' +
      'team, admins anywhere. Links (lead, deal, contact, company) are optional and may be ' +
      'combined; each must be a record you can see. `dueDate` and `reminderAt` are ISO 8601 with ' +
      'a timezone, stored in UTC; a past `dueDate` is allowed, a past `reminderAt` is not. A ' +
      'task.assigned event follows when the assignee is someone other than you.',
  })
  @ApiCreatedResponse({ type: TaskResponseDto })
  @ApiBadRequestResponse({
    description:
      'VALIDATION_FAILED, INVALID_OWNER, INVALID_REMINDER, INVALID_LEAD, INVALID_DEAL, ' +
      'INVALID_CONTACT or INVALID_COMPANY',
  })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing tasks:create)' })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateTaskDto,
  ): Promise<TaskResponseDto> {
    return this.tasks.create(actor, dto);
  }

  @Patch(':id')
  @Permissions('tasks:update')
  @ApiOperation({
    summary: 'Update a task',
    description:
      'Send `null` to clear description, dueDate, reminderAt or a link. Status changes only ' +
      'through the status endpoint (sending it is a 400). A COMPLETED or CANCELLED task is ' +
      'read-only. Changing `assigneeId` reassigns it (a rep who reassigns a task can no longer ' +
      'see it). Changing dueDate or reminderAt re-arms the reminder.',
  })
  @ApiOkResponse({ type: TaskResponseDto })
  @ApiBadRequestResponse({
    description:
      'VALIDATION_FAILED, EMPTY_UPDATE, INVALID_OWNER, INVALID_REMINDER, INVALID_LEAD, ' +
      'INVALID_DEAL, INVALID_CONTACT or INVALID_COMPANY',
  })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing tasks:update)' })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND' })
  @ApiConflictResponse({ description: 'TASK_CLOSED (a closed task is read-only)' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
    @Body() dto: UpdateTaskDto,
  ): Promise<TaskResponseDto> {
    return this.tasks.update(actor, id, dto);
  }

  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  @Permissions('tasks:update')
  @ApiOperation({
    summary: 'Change the status of a task',
    description:
      'OPEN -> IN_PROGRESS | COMPLETED | CANCELLED; IN_PROGRESS -> OPEN | COMPLETED | ' +
      'CANCELLED; COMPLETED / CANCELLED -> OPEN (reopen, which clears completedAt). COMPLETED ' +
      'sets completedAt. The change is computed from the status the server reads, so two racing ' +
      'changes cannot both win; it is not idempotent (asking for the current status is a 409).',
  })
  @ApiOkResponse({ type: TaskResponseDto })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing tasks:update)' })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND' })
  @ApiConflictResponse({
    description:
      'INVALID_TASK_TRANSITION (not possible from the current status) or TASK_STATUS_CHANGED ' +
      '(changed in the meantime: GET the task and decide)',
  })
  changeStatus(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
    @Body() dto: ChangeTaskStatusDto,
  ): Promise<TaskResponseDto> {
    return this.tasks.changeStatus(actor, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions('tasks:delete')
  @ApiOperation({
    summary: 'Delete a task (hard delete)',
    description:
      'A COMPLETED or CANCELLED task can be deleted by an admin only, so its owner cannot erase ' +
      'their own history. Deletions are logged (audit log: Phase 13).',
  })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({
    description:
      'FORBIDDEN (missing tasks:delete) or TASK_DELETE_RESTRICTED (closed task, not admin)',
  })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND (also when already deleted)' })
  delete(@CurrentUser() actor: AuthenticatedUser, @Param() { id }: IdParamDto): Promise<void> {
    return this.tasks.delete(actor, id);
  }
}
