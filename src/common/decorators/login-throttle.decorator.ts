import { SetMetadata } from '@nestjs/common';
import { LOGIN_THROTTLE_KEY } from '../constants/metadata-keys';

// Marks a route for the combined `login` limiter (per IP and per IP + email) instead of the default one.
export const LoginThrottle = () => SetMetadata(LOGIN_THROTTLE_KEY, true);
