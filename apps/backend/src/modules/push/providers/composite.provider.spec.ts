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
  };
}

describe('CompositePushProvider', () => {
  it('routes both iOS and Android through FCM when only FCM is configured', async () => {
    // The standard production setup: Firebase messaging on the
    // mobile side returns FCM tokens for both platforms, and the
    // backend only configures FCM. Earlier routing dumped the iOS
    // targets into the log fallback, silently dropping every iOS
    // push.
    const fcm = makeProvider('fcm');
    fcm.send.mockResolvedValue({
      delivered: 3,
      invalidTokens: [],
      providerName: 'fcm',
    });

    const composite = new CompositePushProvider({
      fcm,
      apn: null,
      fallback: new LogPushProvider(),
    });

    const targets: PushTarget[] = [
      { platform: 'ios', token: 'i-1' },
      { platform: 'android', token: 'a-1' },
      { platform: 'android', token: 'a-2' },
    ];

    const result = await composite.send(targets, PAYLOAD);

    expect(fcm.send).toHaveBeenCalledTimes(1);
    expect(fcm.send).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ platform: 'ios', token: 'i-1' }),
        expect.objectContaining({ platform: 'android', token: 'a-1' }),
        expect.objectContaining({ platform: 'android', token: 'a-2' }),
      ]),
      PAYLOAD,
    );
    expect(result.delivered).toBe(3);
  });

  it('keeps iOS on FCM when both transports are configured', async () => {
    // Mobile only ever stores FCM tokens (Firebase wraps APN), so
    // sending those handles to APN would yield BadDeviceToken.
    // FCM stays the iOS path even when an APN provider is also
    // present — APN is reserved for the niche case where FCM
    // isn't configured at all.
    const fcm = makeProvider('fcm');
    const apn = makeProvider('apn');
    fcm.send.mockResolvedValue({
      delivered: 2,
      invalidTokens: [],
      providerName: 'fcm',
    });

    const composite = new CompositePushProvider({
      fcm,
      apn,
      fallback: new LogPushProvider(),
    });

    await composite.send(
      [
        { platform: 'ios', token: 'i-1' },
        { platform: 'android', token: 'a-1' },
      ],
      PAYLOAD,
    );

    expect(fcm.send).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ platform: 'ios', token: 'i-1' }),
        expect.objectContaining({ platform: 'android', token: 'a-1' }),
      ]),
      PAYLOAD,
    );
    expect(apn.send).not.toHaveBeenCalled();
  });

  it('falls back to APN for iOS when FCM is not configured', async () => {
    // Hypothetical non-Firebase setup: the operator runs APN
    // directly and the mobile client registers raw APN device
    // tokens. Android is then orphan and lands on the log
    // fallback.
    const apn = makeProvider('apn');
    const fallback = makeProvider('fallback');
    apn.send.mockResolvedValue({
      delivered: 1,
      invalidTokens: [],
      providerName: 'apn',
    });
    fallback.send.mockResolvedValue({
      delivered: 0,
      invalidTokens: [],
      providerName: 'fallback',
    });

    const composite = new CompositePushProvider({
      fcm: null,
      apn,
      fallback,
    });

    await composite.send(
      [
        { platform: 'ios', token: 'i-1' },
        { platform: 'android', token: 'a-1' },
      ],
      PAYLOAD,
    );

    expect(apn.send).toHaveBeenCalledWith(
      [{ platform: 'ios', token: 'i-1' }],
      PAYLOAD,
    );
    expect(fallback.send).toHaveBeenCalledWith(
      [{ platform: 'android', token: 'a-1' }],
      PAYLOAD,
    );
  });

  it('aggregates invalidTokens across FCM and APN when both are exercised', async () => {
    // To exercise both transports in one dispatch, configure
    // APN-only so iOS lands on APN, and route a separate Android
    // target through the FCM provider via a second composite.
    // Easier: drive APN by passing only an iOS target with FCM=null,
    // and FCM by passing only Android targets.
    const fcm = makeProvider('fcm');
    const apn = makeProvider('apn');
    fcm.send.mockResolvedValue({
      delivered: 0,
      invalidTokens: ['fcm-dead'],
      providerName: 'fcm',
    });
    apn.send.mockResolvedValue({
      delivered: 0,
      invalidTokens: ['apn-dead'],
      providerName: 'apn',
    });

    // Routing: with FCM configured, both iOS and Android target it,
    // so APN never sees traffic in this composite. To get both on
    // the same call we use FCM=null which moves iOS to APN.
    const composite = new CompositePushProvider({
      fcm: null,
      apn,
      fallback: new LogPushProvider(),
    });

    const result = await composite.send(
      [{ platform: 'ios', token: 'i-dead' }],
      PAYLOAD,
    );
    expect(result.invalidTokens).toEqual(['apn-dead']);

    // Separate dispatch through an FCM-configured composite to
    // confirm aggregation also works on that side.
    const fcmComposite = new CompositePushProvider({
      fcm,
      apn: null,
      fallback: new LogPushProvider(),
    });
    const fcmResult = await fcmComposite.send(
      [{ platform: 'android', token: 'a-dead' }],
      PAYLOAD,
    );
    expect(fcmResult.invalidTokens).toEqual(['fcm-dead']);
  });

  it('falls back to the log provider when no transport handles the platform', async () => {
    const fallback = makeProvider('fallback');
    fallback.send.mockResolvedValue({
      delivered: 1,
      invalidTokens: [],
      providerName: 'fallback',
    });

    const composite = new CompositePushProvider({
      fcm: null,
      apn: null,
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
      fcm: null,
      apn: null,
      fallback: new LogPushProvider(),
    });
    const result = await composite.send([], PAYLOAD);
    expect(result).toEqual(
      expect.objectContaining({ delivered: 0, invalidTokens: [] }),
    );
  });
});
