import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

// Usage: `@CurrentUser() user` for the whole object or `@CurrentUser('userId') id` for one field.
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const { user } = ctx.switchToHttp().getRequest<Request & { user: AuthenticatedUser }>();
    return field ? user[field] : user;
  },
);
