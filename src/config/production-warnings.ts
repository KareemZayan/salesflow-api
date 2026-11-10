import { AppConfig } from './app.config';

// Settings that are valid but, in production, usually mean a forgotten step or a risky shortcut. They only warn: both
// can be correct (an API reached directly, or a deployment with no browser client), so refusing to
// start would be wrong. The settings that must never be missing fail validation instead
// (env.schema.ts). Nothing here is development-only, so other environments get no warnings.
export function productionConfigWarnings(
  config: Pick<AppConfig, 'nodeEnv' | 'trustProxy' | 'corsOrigins'>,
): string[] {
  if (config.nodeEnv !== 'production') return [];

  const warnings: string[] = [];
  if (config.trustProxy === false) {
    warnings.push(
      'TRUST_PROXY is false: if the API sits behind a reverse proxy or load balancer, every client ' +
        'shares the proxy IP and one rate-limit bucket. Set it to the number of proxy hops.',
    );
  }
  if (config.trustProxy === true) {
    warnings.push(
      'TRUST_PROXY is true: every X-Forwarded-For hop is trusted. If the API is not really behind ' +
        'a trusted proxy, any client can forge that header to bypass rate limiting and to write a ' +
        'fake IP into the audit log. Set it to the exact number of proxy hops (for example 1), or to ' +
        'the proxy subnet.',
    );
  }
  if (config.corsOrigins.length === 0) {
    warnings.push(
      'CORS_ORIGINS is empty: browsers on other origins are blocked. Set it to the frontend ' +
        'origin(s) if a browser app calls this API.',
    );
  }
  return warnings;
}
