// Everything this application keeps in Redis lives under `<QUEUE_PREFIX>:`. BullMQ owns
// `<prefix>:<queue name>:...`; the other users get a namespace of their own, listed here, so two
// features can never write the same key. redis-namespaces.spec.ts fails if a queue is ever named like
// one of these.
export const REDIS_NAMESPACE = {
  cache: 'cache',
  throttle: 'throttle',
} as const;

export type RedisNamespace = keyof typeof REDIS_NAMESPACE;
