import { applyDecorators, Type } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, getSchemaPath } from '@nestjs/swagger';
import { PageMetaDto, PaginatedResponseDto } from '../dto/paginated-response.dto';

// Swagger cannot read generics, so this documents `{ data: Model[], meta }` explicitly.
export const ApiPaginatedResponse = <T extends Type<unknown>>(model: T) =>
  applyDecorators(
    ApiExtraModels(PaginatedResponseDto, PageMetaDto, model),
    ApiOkResponse({
      schema: {
        properties: {
          data: { type: 'array', items: { $ref: getSchemaPath(model) } },
          meta: { $ref: getSchemaPath(PageMetaDto) },
        },
      },
    }),
  );
