import { SetMetadata } from '@nestjs/common';
import { ALLOW_PASSWORD_CHANGE_KEY } from '../constants/metadata-keys';

// Routes a user may call while `mustChangePassword` is set (`me`, `change-password`).
// Everything else answers 403 PASSWORD_CHANGE_REQUIRED.
export const AllowWhenPasswordChangeRequired = () => SetMetadata(ALLOW_PASSWORD_CHANGE_KEY, true);
