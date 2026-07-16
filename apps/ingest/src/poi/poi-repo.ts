import { ServiceUnavailableException } from "@nestjs/common";
import { DataSource, Repository } from "typeorm";
import { Poi } from "@tarmoto/poi-db";

const POI_UNAVAILABLE = "POI store is temporarily unavailable";

/**
 * True for driver/pool errors that mean the POI connection is DOWN or the DB
 * can't serve the request right now (vs. a query/logic error), so the store can
 * answer 503 instead of 500. Covers pg SQLSTATE class 08 (connection_exception),
 * class 53 (insufficient_resources, incl. 53300 too_many_connections), the 57Pxx
 * shutdown codes, and node socket error codes / "connection terminated" messages.
 *
 * Local copy of the backend's `poi-repo.ts` helper (apps/ingest extraction,
 * T5): `PoiImportService` (moved here verbatim) depends on `withPoiRepo`, but
 * the backend keeps its own copy for its (unmoved) live read-path consumers
 * (`poi.service.ts`, `poi-store.service.ts`, `poi-import-admin.service.ts`,
 * `poi-database.module.ts`) — this file isn't in Task 5's move list, so it's
 * duplicated rather than shared cross-app.
 */
export function isPoiConnectionError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string") {
    if (code.startsWith("08")) return true;
    if (["57P01", "57P02", "57P03"].includes(code)) return true;
    // Class 53 = insufficient_resources: too_many_connections (53300),
    // out_of_memory, disk_full, etc. The DB is reachable but can't serve the
    // request right now — a transient unavailable state, not a query/logic
    // bug — so degrade (retry / 503) rather than rethrow at boot or 500 at
    // runtime.
    if (code.startsWith("53")) return true;
    if (
      [
        "ECONNREFUSED",
        "ECONNRESET",
        "EPIPE",
        "ETIMEDOUT",
        "ENOTFOUND",
      ].includes(code)
    )
      return true;
  }
  const msg = err instanceof Error ? err.message : "";
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
