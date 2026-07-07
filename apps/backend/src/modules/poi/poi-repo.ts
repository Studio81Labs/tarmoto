import { ServiceUnavailableException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { Poi } from '../../entities/poi.entity.js';

const POI_UNAVAILABLE = 'POI store is temporarily unavailable';

/**
 * True for driver/pool errors that mean the POI connection is DOWN (vs. a
 * query/logic error), so the store can answer 503 instead of 500. Covers
 * pg SQLSTATE class 08 (connection_exception), the 57Pxx shutdown codes, and
 * node socket error codes / "connection terminated" style messages.
 */
export function isPoiConnectionError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string') {
    if (code.startsWith('08')) return true;
    if (['57P01', '57P02', '57P03'].includes(code)) return true;
    if (
      [
        'ECONNREFUSED',
        'ECONNRESET',
        'EPIPE',
        'ETIMEDOUT',
        'ENOTFOUND',
      ].includes(code)
    )
      return true;
  }
  const msg = err instanceof Error ? err.message : '';
  return /terminat(ing|ed)|ECONNREFUSED|ECONNRESET|connection.*(closed|refused|reset|lost)|server closed the connection|pool is draining/i.test(
    msg,
  );
}

/**
 * Run a POI-store operation against the resilient 'poi' connection (ADR 0007),
 * mapping BOTH "never connected" (cold start) and "connection dropped at
 * runtime" to an explicit 503 — never a 500 and never a silent empty result.
 * A genuine query/logic error (e.g. a unique-violation) is re-thrown as-is.
 */
export async function withPoiRepo<T>(
  dataSource: DataSource,
  op: (repo: Repository<Poi>) => Promise<T>,
): Promise<T> {
  if (!dataSource.isInitialized) {
    throw new ServiceUnavailableException(POI_UNAVAILABLE);
  }
  try {
    return await op(dataSource.getRepository(Poi));
  } catch (err) {
    if (err instanceof ServiceUnavailableException) throw err;
    if (isPoiConnectionError(err))
      throw new ServiceUnavailableException(POI_UNAVAILABLE);
    throw err;
  }
}
