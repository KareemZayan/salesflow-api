import { applyDecorators, Type } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, getSchemaPath } from '@nestjs/swagger';
import { CursorMetaDto, CursorPaginatedResponseDto } from '../dto/paginated-response.dto';

// Swagger cannot read generics, so this documents `{ data: Model[], meta: { limit, nextCursor } }`.
export const ApiCursorPaginatedResponse = <T extends Type<unknown>>(model: T) =>
  applyDecorators(
    ApiExtraModels(CursorPaginatedResponseDto, CursorMetaDto, model),
    ApiOkResponse({
      schema: {
        properties: {
          data: { type: 'array', items: { $ref: getSchemaPath(model) } },
          meta: { $ref: getSchemaPath(CursorMetaDto) },
        },
      },
    }),
  );
