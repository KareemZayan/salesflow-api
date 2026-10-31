import { SetMetadata } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../constants/metadata-keys';

// Opts a route out of the global JwtAuthGuard (added in Phase 6).
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
