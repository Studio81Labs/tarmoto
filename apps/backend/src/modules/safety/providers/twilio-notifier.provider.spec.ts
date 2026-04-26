/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { TwilioCrashAlertNotifier } from './twilio-notifier.provider.js';
import type {
  CrashAlertContext,
  CrashAlertRecipient,
} from '../crash-alert-notifier.interface.js';

describe('TwilioCrashAlertNotifier', () => {
  const baseRecipient: CrashAlertRecipient = {
    contact_id: 'c-1',
    name: 'Jane',
    phone: '+420111222333',
  };

  const baseContext: CrashAlertContext = {
    alert_id: '00000000-0000-4000-8000-00000000abcd',
    rider_name: 'TestRider',
    lat: 49.1,
    lng: 16.75,
    maps_link: 'https://maps.google.com/?q=49.1,16.75',
    ride_id: 'ride-1',
    speed_kmh: 72,
    severity: 'high',
    timestamp: '2026-04-25T12:00:00.000Z',
    message: 'Tarmoto crash alert: TestRider at 49.10000,16.75000',
  };

  function buildProvider(env: Record<string, string>) {
    const config = {
      get: jest.fn((key: string, def?: string) => env[key] ?? def ?? ''),
    };
    return Test.createTestingModule({
      providers: [
        TwilioCrashAlertNotifier,
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('without credentials', () => {
    let provider: TwilioCrashAlertNotifier;

    beforeEach(async () => {
      const module: TestingModule = await buildProvider({});
      provider = module.get(TwilioCrashAlertNotifier);
      global.fetch = jest.fn();
    });

    it('reports unconfigured', () => {
      expect(provider.isConfigured()).toBe(false);
    });

    it('falls back to log-only without calling Twilio', async () => {
      const result = await provider.send('sms', baseRecipient, baseContext);

      expect(result).toEqual({ channel: 'sms', provider_message_id: null });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('falls back to log-only for voice channel too', async () => {
      const result = await provider.send('voice', baseRecipient, baseContext);
      expect(result.channel).toBe('voice');
      expect(result.provider_message_id).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('with credentials', () => {
    let provider: TwilioCrashAlertNotifier;

    beforeEach(async () => {
      const module: TestingModule = await buildProvider({
        TARMOTO_TWILIO_ACCOUNT_SID: 'ACxxx',
        TARMOTO_TWILIO_AUTH_TOKEN: 'token',
        TARMOTO_TWILIO_FROM_NUMBER: '+420900000000',
      });
      provider = module.get(TwilioCrashAlertNotifier);
    });

    it('reports configured', () => {
      expect(provider.isConfigured()).toBe(true);
    });

    it('POSTs to the Messages endpoint with form-encoded body for SMS', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ sid: 'SM123' }),
      });

      const result = await provider.send('sms', baseRecipient, baseContext);

      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = (fetch as jest.Mock).mock.calls[0];
      expect(url).toBe(
        'https://api.twilio.com/2010-04-01/Accounts/ACxxx/Messages.json',
      );
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toMatch(/^Basic /);
      expect(init.headers['Content-Type']).toBe(
        'application/x-www-form-urlencoded',
      );
      expect(init.headers['I-Twilio-Idempotency-Token']).toBe(
        `${baseContext.alert_id}:${baseRecipient.contact_id}:sms`,
      );
      const body = new URLSearchParams(init.body as string);
      expect(body.get('To')).toBe('+420111222333');
      expect(body.get('From')).toBe('+420900000000');
      expect(body.get('Body')).toBe(baseContext.message);
      expect(result).toEqual({ channel: 'sms', provider_message_id: 'SM123' });
    });

    it('uses inline TwiML for voice when no callback URL is configured', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ sid: 'CA456' }),
      });

      const result = await provider.send('voice', baseRecipient, baseContext);

      const [url, init] = (fetch as jest.Mock).mock.calls[0];
      expect(url).toBe(
        'https://api.twilio.com/2010-04-01/Accounts/ACxxx/Calls.json',
      );
      const body = new URLSearchParams(init.body as string);
      expect(body.get('Twiml')).toContain('<Say>');
      expect(body.get('Url')).toBeNull();
      expect(result).toEqual({
        channel: 'voice',
        provider_message_id: 'CA456',
      });
    });

    it('entity-encodes XML special characters in inline TwiML rather than stripping them', async () => {
      // A rider's display name like `Jonas & Co` would otherwise be
      // silently dropped from the spoken alert; the renderer now
      // emits `&amp;` so Twilio reads it back faithfully.
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ sid: 'CA-amp' }),
      });

      await provider.send('voice', baseRecipient, {
        ...baseContext,
        message: 'Jonas & Co at <49.1,16.75> - "help"',
      });

      const [, init] = (fetch as jest.Mock).mock.calls[0];
      const body = new URLSearchParams(init.body as string);
      const twiml = body.get('Twiml') ?? '';
      // Body content uses entities, the wrapping <Response>/<Say> tags
      // remain literal so the XML still parses.
      expect(twiml).toContain('Jonas &amp; Co');
      expect(twiml).toContain('&lt;49.1,16.75&gt;');
      expect(twiml).not.toContain('Jonas  Co'); // no whitespace stripping
      expect(twiml.startsWith('<Response><Say>')).toBe(true);
      expect(twiml.endsWith('</Say></Response>')).toBe(true);
    });

    it('uses configured TwiML callback URL when provided', async () => {
      const module: TestingModule = await buildProvider({
        TARMOTO_TWILIO_ACCOUNT_SID: 'ACxxx',
        TARMOTO_TWILIO_AUTH_TOKEN: 'token',
        TARMOTO_TWILIO_FROM_NUMBER: '+420900000000',
        TARMOTO_TWILIO_VOICE_TWIML_URL: 'https://example.com/twiml',
      });
      const p = module.get<TwilioCrashAlertNotifier>(TwilioCrashAlertNotifier);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ sid: 'CA789' }),
      });

      await p.send('voice', baseRecipient, baseContext);

      const [, init] = (fetch as jest.Mock).mock.calls[0];
      const body = new URLSearchParams(init.body as string);
      expect(body.get('Url')).toBe('https://example.com/twiml');
      expect(body.get('Twiml')).toBeNull();
    });

    it('throws with the Twilio error message on non-2xx response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: () => Promise.resolve({ message: 'Authenticate', code: 20003 }),
      });

      await expect(
        provider.send('sms', baseRecipient, baseContext),
      ).rejects.toThrow('Twilio API error: Authenticate');
    });

    it('aborts a hung request and throws a timeout error', async () => {
      // Simulate a blackholed Twilio call: fetch never resolves on its
      // own, only when the AbortController fires. Without the
      // provider's hard timeout this would hang the dispatch and keep
      // the audit row in-flight indefinitely.
      global.fetch = jest.fn(
        (_url: string, init: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const err = new Error('aborted') as Error & { name: string };
              err.name = 'AbortError';
              reject(err);
            });
          }),
      ) as unknown as typeof fetch;

      jest.useFakeTimers();
      // Attach a catch up-front so the rejection isn't reported as
      // unhandled while we're advancing timers.
      const promise = provider.send('sms', baseRecipient, baseContext);
      const captured = promise.catch((e: Error) => e);
      // Advance past the 10 s timeout the provider sets.
      await jest.advanceTimersByTimeAsync(11_000);
      const err = await captured;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('Twilio API timeout');
      jest.useRealTimers();
    });
  });
});
