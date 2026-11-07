import { Queue } from 'bullmq';
import { QueueName } from './queue.constants';

// Every registered queue by name, so the producer service needs one injection instead of one per
// queue.
export const QUEUES = Symbol('QUEUES');
export type QueueRegistry = Record<QueueName, Queue>;
