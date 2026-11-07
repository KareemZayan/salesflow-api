// A cache lookup that takes longer than this is treated as a miss: a slow Redis must not make
// reports slower than computing them.
export const CACHE_OPERATION_TIMEOUT_MS = 500;
