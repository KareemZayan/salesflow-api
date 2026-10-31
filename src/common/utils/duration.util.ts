const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

// Env-friendly durations ("15m", "7d"). The same string feeds jsonwebtoken (`expiresIn`) and the
// refresh-token expiry, so both always agree.
export const DURATION_PATTERN = /^[1-9]\d*[smhd]$/;

export function parseDurationMs(value: string): number {
  if (!DURATION_PATTERN.test(value)) throw new Error(`Invalid duration "${value}"`);
  return Number(value.slice(0, -1)) * UNIT_MS[value.slice(-1) as keyof typeof UNIT_MS];
}
