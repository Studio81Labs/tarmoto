import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NapClientService } from './nap-client.service.js';
import type { NapConfig } from './nap.config.js';

function build(over: Partial<NapConfig> = {}) {
  const config: NapConfig = {
    snapshotUrl: 'https://ndic.example/pull',
    username: '',
    password: '',
    clientCertPath: '',
    clientKeyPath: '',
    source: 'official',
    countryCode: 'CZ',
    pollEnabled: true,
    ...over,
  };
  return new NapClientService(config);
}

describe('NapClientService cert handling', () => {
  it('throws when no snapshot URL is configured', async () => {
    await expect(build({ snapshotUrl: '' }).fetchSnapshot()).rejects.toThrow(
      /TARMOTO_NAP_SNAPSHOT_URL/,
    );
  });

  it('does not memoise a failed mTLS cert read — a later poll retries', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nap-cert-'));
    const certPath = path.join(dir, 'nap.crt');
    const keyPath = path.join(dir, 'nap.key');
    // 127.0.0.1:1 refuses fast (no real network), so once we get past the
    // cert read the request fails with a connection error, not ENOENT.
    const service = build({
      snapshotUrl: 'https://127.0.0.1:1/pull',
      clientCertPath: certPath,
      clientKeyPath: keyPath,
    });

    try {
      // First poll: the secret isn't mounted yet → cert read fails.
      await expect(service.fetchSnapshot()).rejects.toThrow(
        /ENOENT|no such file/,
      );

      // Secret mounted now. Because the failure was NOT cached, the next
      // poll re-reads the cert and gets past it (failing only on connect).
      fs.writeFileSync(certPath, 'pem-cert');
      fs.writeFileSync(keyPath, 'pem-key');
      await expect(service.fetchSnapshot()).rejects.not.toThrow(
        /ENOENT|no such file/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
