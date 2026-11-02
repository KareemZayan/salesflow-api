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
import { ContactsService } from './contacts.service';
import { ContactResponseDto } from './dto/contact-response.dto';
import { CreateContactDto } from './dto/create-contact.dto';
import { ListContactsQueryDto } from './dto/list-contacts-query.dto';
import { UpdateContactDto } from './dto/update-contact.dto';

@ApiTags('Contacts')
@ApiBearerAuth()
@Controller('contacts')
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  @Permissions('contacts:read')
  @ApiOperation({
    summary: 'List the contacts you may see',
    description:
      'Admins see the whole organization, managers their own and their team, everyone else only ' +
      'their own. `ownerId` and `companyId` narrow the list; they never widen it. Offset ' +
      'pagination: contact lists are small and not append-heavy.',
  })
  @ApiPaginatedResponse(ContactResponseDto)
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED or INVALID_SORT_FIELD' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing contacts:read)' })
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListContactsQueryDto,
  ): Promise<PaginatedResponseDto<ContactResponseDto>> {
    return this.contacts.list(actor, query);
  }

  @Get(':id')
  @Permissions('contacts:read')
  @ApiOperation({ summary: 'Get one contact' })
  @ApiOkResponse({ type: ContactResponseDto })
  @ApiNotFoundResponse({
    description: 'RESOURCE_NOT_FOUND (also when it is another organization or not yours to see)',
  })
  get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
  ): Promise<ContactResponseDto> {
    return this.contacts.get(actor, id);
  }

  @Post()
  @Permissions('contacts:create')
  @ApiOperation({
    summary: 'Create a contact',
    description:
      'The owner defaults to you. Email is optional and not unique. `companyId` must be a ' +
      'company you can see.',
  })
  @ApiCreatedResponse({ type: ContactResponseDto })
  @ApiBadRequestResponse({
    description: 'VALIDATION_FAILED, INVALID_OWNER or INVALID_COMPANY',
  })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing contacts:create)' })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateContactDto,
  ): Promise<ContactResponseDto> {
    return this.contacts.create(actor, dto);
  }

  @Patch(':id')
  @Permissions('contacts:update')
  @ApiOperation({
    summary: 'Update a contact',
    description:
      'Send `null` (or a blank string) to clear email, phone or jobTitle; `companyId: null` ' +
      'unlinks the company. An empty body is rejected. Changing `ownerId` transfers the contact: ' +
      'reps cannot, managers can within their team, admins anywhere.',
  })
  @ApiOkResponse({ type: ContactResponseDto })
  @ApiBadRequestResponse({
    description: 'VALIDATION_FAILED, EMPTY_UPDATE, INVALID_OWNER or INVALID_COMPANY',
  })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing contacts:update)' })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
    @Body() dto: UpdateContactDto,
  ): Promise<ContactResponseDto> {
    return this.contacts.update(actor, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions('contacts:delete')
  @ApiOperation({ summary: 'Delete a contact (soft delete)' })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing contacts:delete)' })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND (also when already deleted)' })
  delete(@CurrentUser() actor: AuthenticatedUser, @Param() { id }: IdParamDto): Promise<void> {
    return this.contacts.delete(actor, id);
  }
}
