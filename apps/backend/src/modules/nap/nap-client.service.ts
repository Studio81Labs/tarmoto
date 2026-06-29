import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import * as fs from 'node:fs';
import * as https from 'node:https';
import { napConfig } from './nap.config.js';

/**
 * Fetches the raw DATEX II snapshot from the Czech NAP (NDIC).
 *
 * NDIC access is credential-based (obtained at registration). Two modes
 * are supported; configure whichever your registration uses:
 *   - HTTP Basic auth → `TARMOTO_NAP_USERNAME` / `TARMOTO_NAP_PASSWORD`
 *   - Mutual TLS      → `TARMOTO_NAP_CLIENT_CERT_PATH` / `_CLIENT_KEY_PATH`
 *
 * Uses `node:https` directly (the backend has no axios dependency) so
 * both a client certificate and Basic auth are first-class. The cert is
 * read once and memoised.
 */
@Injectable()
export class NapClientService {
  private readonly logger = new Logger(NapClientService.name);
  private tls: { cert: Buffer; key: Buffer } | undefined;

  constructor(
    @Inject(napConfig.KEY)
    private readonly config: ConfigType<typeof napConfig>,
  ) {}

  async fetchSnapshot(): Promise<string> {
    if (!this.config.snapshotUrl) {
      throw new Error('TARMOTO_NAP_SNAPSHOT_URL is not configured');
    }
    const url = new URL(this.config.snapshotUrl);
    const tls = this.loadClientCert();
    const { username, password } = this.config;

    return new Promise<string>((resolve, reject) => {
      const req = https.request(
        url,
        {
          method: 'GET',
          timeout: 30_000,
          headers: { Accept: 'application/xml,text/xml' },
          auth: username && password ? `${username}:${password}` : undefined,
          ...(tls ? { cert: tls.cert, key: tls.key } : {}),
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            if (status < 200 || status >= 300) {
              reject(new Error(`NAP snapshot request failed: HTTP ${status}`));
            } else if (!body) {
              reject(new Error('Empty snapshot response from NAP'));
            } else {
              resolve(body);
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () =>
        req.destroy(new Error('NAP snapshot request timed out')),
      );
      req.end();
    });
  }

  /**
   * Read the mutual-TLS client cert, if configured, memoising only on
   * SUCCESS. A failed read (bad path, permissions, secret mounted late)
   * is NOT cached — it propagates so the poll fails with the real error,
   * and the next poll retries the read, letting a fixed secret recover
   * without a worker restart. When no cert is configured this is a cheap
   * no-op every call (no fs touch).
   */
  private loadClientCert(): { cert: Buffer; key: Buffer } | undefined {
    if (this.tls) return this.tls;
    const { clientCertPath, clientKeyPath } = this.config;
    if (!clientCertPath || !clientKeyPath) return undefined;
    this.tls = {
      cert: fs.readFileSync(clientCertPath),
      key: fs.readFileSync(clientKeyPath),
    };
    return this.tls;
  }
}
