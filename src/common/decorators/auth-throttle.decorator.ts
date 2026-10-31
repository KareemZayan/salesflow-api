import { SetMetadata } from '@nestjs/common';
import { AUTH_THROTTLE_KEY } from '../constants/metadata-keys';

// Marks a route for the stricter `auth` throttler (THROTTLE_AUTH_LIMIT) instead of the default one.
export const AuthThrottle = () => SetMetadata(AUTH_THROTTLE_KEY, true);
