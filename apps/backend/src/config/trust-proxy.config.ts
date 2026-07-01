/**
 * Configuration for Express' `trust proxy` setting, which drives per-client IP
 * resolution for `req.ip` — and therefore the ThrottlerGuard's per-client bucket.
 *
 * Using `trust proxy: true` would let any upstream spoof `X-Forwarded-For` and
 * bypass throttling. Instead, operators declare the exact number of trusted
 * reverse-proxy hops between the internet and the app (e.g. 1 for a single CDN
 * in front, 2 for CDN → LB → app). Hop count 0 (the default) means the app is
 * directly exposed and `X-Forwarded-For` is ignored.
 *
 * See docs/process/runbook.md § "Proxy & throttling" for deployment guidance.
 */

const ENV_KEY = 'TARMOTO_TRUSTED_PROXY_HOPS';

export interface TrustProxyConfig {
  hops: number;
}

export function loadTrustProxyConfig(
  env: NodeJS.ProcessEnv = process.env,
): TrustProxyConfig {
  const raw = env[ENV_KEY];
  if (raw === undefined || raw.trim() === '') {
    return { hops: 0 };
  }
  const trimmed = raw.trim();
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || !/^\d+$/.test(trimmed)) {
    throw new Error(
      `${ENV_KEY} must be a non-negative integer (got: "${raw}"). ` +
        `See docs/process/runbook.md § "Proxy & throttling".`,
    );
  }
  return { hops: parsed };
}
