import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { graphhopperReimportConfig } from './graphhopper-reimport.config.js';

/** How long to wait on the webhook before treating it as failed. The receiver
 *  should return as soon as it has ACCEPTED the re-import (kick off async), not
 *  after the import finishes — a country import takes minutes. */
const REIMPORT_TIMEOUT_MS = 30_000;

/**
 * Fires the configured re-import webhook after a successful quality conflation
 * (#779), so GraphHopper re-imports the freshly `smoothness`-tagged extract.
 *
 * The backend does not restart GraphHopper itself: GraphHopper has no re-import
 * API and reuses its `graph-cache`, and it may live in a sibling container or on
 * a separate host. So this is a thin, host-agnostic HTTP trigger — the receiver
 * (a Coolify deploy webhook, a small sidecar, etc.) owns the actual cache-bust +
 * restart. See {@link GraphHopperReimportConfig} and the module README.
 *
 * When the webhook is unconfigured the trigger is a silent no-op (the derived
 * extract is still produced; an operator re-imports manually). When it IS
 * configured, a non-2xx response or a connection failure **throws** — the
 * conflation job then fails visibly and BullMQ retries, rather than leaving
 * routing silently stale on the previous graph.
 */
@Injectable()
export class GraphHopperReimportService {
  private readonly logger = new Logger(GraphHopperReimportService.name);

  constructor(
    @Inject(graphhopperReimportConfig.KEY)
    private readonly config: ConfigType<typeof graphhopperReimportConfig>,
  ) {}

  /** Whether a re-import webhook is configured (else `trigger()` no-ops). */
  get configured(): boolean {
    return this.config.webhookUrl !== null;
  }

  /**
   * Trigger a GraphHopper re-import. Returns `{ triggered: false }` when no
   * webhook is configured; throws on a connection error or non-2xx response.
   */
  async trigger(): Promise<{ triggered: boolean }> {
    const { webhookUrl, token, method } = this.config;
    if (!webhookUrl) {
      this.logger.debug(
        'GraphHopper re-import webhook not configured ' +
          '(TARMOTO_GRAPHHOPPER_REIMPORT_WEBHOOK_URL unset); skipping trigger',
      );
      return { triggered: false };
    }

    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    let res: Response;
    try {
      res = await fetch(webhookUrl, {
        method,
        headers,
        signal: AbortSignal.timeout(REIMPORT_TIMEOUT_MS),
      });
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `GraphHopper re-import webhook (${method} ${redactUrl(webhookUrl)}) ` +
          `failed to connect: ${reason}`,
        { cause: err },
      );
    }
    if (!res.ok) {
      throw new Error(
        `GraphHopper re-import webhook (${method} ${redactUrl(webhookUrl)}) ` +
          `returned ${res.status} ${res.statusText}`,
      );
    }
    this.logger.log(
      `GraphHopper re-import triggered via ${method} ${redactUrl(webhookUrl)} ` +
        `(${res.status})`,
    );
    return { triggered: true };
  }
}

/**
 * Strip the query string (and any userinfo) before logging — Coolify deploy
 * webhooks carry the resource UUID and sometimes a token in the query, which
 * must not leak into logs.
 */
function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const suffix = url.search ? '?…' : '';
    return `${url.protocol}//${url.host}${url.pathname}${suffix}`;
  } catch {
    return '<invalid-url>';
  }
}
