import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTH_THROTTLE_KEY } from '../constants/metadata-keys';

const MAX_EMAIL_LENGTH = 254;
const reflector = new Reflector();

export function isAuthThrottled(context: ExecutionContext): boolean {
  return (
    reflector.getAllAndOverride<boolean | undefined>(AUTH_THROTTLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) === true
  );
}

// Login is limited per IP + email: a single IP cannot spray many accounts cheaply, and one
// attacker cannot lock a victim out from every other IP. The body is not validated yet when
// guards run, so `email` can be anything; only a string is used, normalized and length-capped.
export function authThrottleTracker(req: Record<string, unknown>): string {
  const ip = typeof req.ip === 'string' ? req.ip : 'unknown';
  const body = req.body;
  const email =
    typeof body === 'object' && body !== null ? (body as { email?: unknown }).email : undefined;
  if (typeof email !== 'string' || email.trim() === '') return ip;
  return `${ip}|${email.trim().toLowerCase().slice(0, MAX_EMAIL_LENGTH)}`;
}
