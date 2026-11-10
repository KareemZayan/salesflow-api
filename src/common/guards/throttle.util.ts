import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { normalizeIp } from '@nestjs/throttler';
import { AUTH_THROTTLE_KEY, LOGIN_THROTTLE_KEY } from '../constants/metadata-keys';
import { IPV6_SUBNET_PREFIX } from '../constants/throttle.constants';

const MAX_EMAIL_LENGTH = 254;
const reflector = new Reflector();

const hasMarker = (key: string, context: ExecutionContext): boolean =>
  reflector.getAllAndOverride<boolean | undefined>(key, [
    context.getHandler(),
    context.getClass(),
  ]) === true;

export const isAuthThrottled = (context: ExecutionContext): boolean =>
  hasMarker(AUTH_THROTTLE_KEY, context);

export const isLoginThrottled = (context: ExecutionContext): boolean =>
  hasMarker(LOGIN_THROTTLE_KEY, context);

// The client address as the limiter sees it. IPv4 is unchanged; an IPv4-mapped IPv6 address
// (::ffff:1.2.3.4) is read as the IPv4 address; any other IPv6 address becomes its /64, so every
// address a customer owns lands in the same bucket and rotating through them gains nothing.
export function clientIp(req: Record<string, unknown>): string {
  const ip = req.ip;
  if (typeof ip !== 'string' || ip === '') return 'unknown';
  return normalizeIp(ip, IPV6_SUBNET_PREFIX);
}

function normalizedEmail(body: unknown): string {
  const email =
    typeof body === 'object' && body !== null ? (body as { email?: unknown }).email : undefined;
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase().slice(0, MAX_EMAIL_LENGTH);
}

// Tracker of the `auth` throttler (refresh and change-password): the client IP. Those bodies carry no
// email, so in practice this is the IP alone; an email, if one is ever sent, is part of the key.
// The body is not validated yet when guards run, so `email` can be anything; only a string is used.
export function authThrottleTracker(req: Record<string, unknown>): string {
  const ip = clientIp(req);
  const email = normalizedEmail(req.body);
  return email === '' ? ip : `${ip}|${email}`;
}

// Tracker of the `login` throttler: ALWAYS `<normalized ip>|<normalized email>`, with an empty email
// when the body has none (or not a string). The storage splits it at the first `|`: an IP never contains
// one, an email may, so the first is always the separator. Both halves are hashed before they reach
// Redis; the raw values exist only in memory for the length of the request.
//
// What this does and does not limit (the previous version of this comment overstated it): the
// per-account bucket is per IP + email, so one IP cannot lock a victim out from other IPs, and it also
// does not stop one IP from trying many accounts. That is the job of the per-IP half of the same
// operation, which counts every admitted attempt from the IP whatever the email.
export function loginThrottleTracker(req: Record<string, unknown>): string {
  return `${clientIp(req)}|${normalizedEmail(req.body)}`;
}
