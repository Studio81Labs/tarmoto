/* eslint-disable @typescript-eslint/unbound-method */
import { CompositePushProvider } from './composite.provider.js';
import { LogPushProvider } from './log.provider.js';
import {
  type PushPayload,
  type PushProvider,
  type PushTarget,
} from '../push-provider.js';

const PAYLOAD: PushPayload = {
  title: 't',
  body: 'b',
  category: 'new_follower',
};

function makeProvider(name: string): jest.Mocked<PushProvider> {
  return {
    name,
    send: jest.fn().mockResolvedValue({
      delivered: 0,
      invalidTokens: [],
      providerName: name,
    }),
  } as unknown as jest.Mocked<PushProvider>;
}

describe('CompositePushProvider', () => {
  it('routes ios targets to the APN provider and android to FCM', async () => {
    const apn = makeProvider('apn');
    const fcm = makeProvider('fcm');
    apn.send.mockResolvedValue({
      delivered: 1,
      invalidTokens: [],
      providerName: 'apn',
    });
    fcm.send.mockResolvedValue({
      delivered: 2,
      invalidTokens: [],
      providerName: 'fcm',
    });

    const composite = new CompositePushProvider({
      ios: apn,
      android: fcm,
      fallback: new LogPushProvider(),
    });

    const targets: PushTarget[] = [
      { platform: 'ios', token: 'i-1' },
      { platform: 'android', token: 'a-1' },
      { platform: 'android', token: 'a-2' },
    ];

    const result = await composite.send(targets, PAYLOAD);

    expect(apn.send).toHaveBeenCalledWith(
      [{ platform: 'ios', token: 'i-1' }],
      PAYLOAD,
    );
    expect(fcm.send).toHaveBeenCalledWith(
      [
        { platform: 'android', token: 'a-1' },
        { platform: 'android', token: 'a-2' },
      ],
      PAYLOAD,
    );
    expect(result.delivered).toBe(3);
  });

  it('aggregates invalidTokens across the per-platform results', async () => {
    const apn = makeProvider('apn');
    const fcm = makeProvider('fcm');
    apn.send.mockResolvedValue({
      delivered: 0,
      invalidTokens: ['i-dead'],
      providerName: 'apn',
    });
    fcm.send.mockResolvedValue({
      delivered: 1,
      invalidTokens: ['a-dead'],
      providerName: 'fcm',
    });

    const composite = new CompositePushProvider({
      ios: apn,
      android: fcm,
      fallback: new LogPushProvider(),
    });

    const result = await composite.send(
      [
        { platform: 'ios', token: 'i-dead' },
        { platform: 'android', token: 'a-dead' },
      ],
      PAYLOAD,
    );

    expect(result.invalidTokens).toEqual(
      expect.arrayContaining(['i-dead', 'a-dead']),
    );
    expect(result.delivered).toBe(1);
  });

  it('falls back to the log provider when a platform has no transport', async () => {
    const fallback = makeProvider('fallback');
    fallback.send.mockResolvedValue({
      delivered: 1,
      invalidTokens: [],
      providerName: 'fallback',
    });

    const composite = new CompositePushProvider({
      ios: null,
      android: null,
      fallback,
    });

    await composite.send([{ platform: 'ios', token: 'i-1' }], PAYLOAD);
    expect(fallback.send).toHaveBeenCalledWith(
      [{ platform: 'ios', token: 'i-1' }],
      PAYLOAD,
    );
  });

  it('returns zero with no targets', async () => {
    const composite = new CompositePushProvider({
      ios: null,
      android: null,
      fallback: new LogPushProvider(),
    });
    const result = await composite.send([], PAYLOAD);
    expect(result).toEqual(
      expect.objectContaining({ delivered: 0, invalidTokens: [] }),
    );
  });
});
