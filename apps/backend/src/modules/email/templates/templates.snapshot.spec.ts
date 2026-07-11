import {
  verificationTemplate,
  passwordResetTemplate,
  passwordChangedTemplate,
  subscriptionConfirmedTemplate,
  subscriptionCancelledTemplate,
  dataExportReadyTemplate,
  accountDeletionScheduledTemplate,
  tripInviteTemplate,
  weeklyDigestTemplate,
  accountDeletionCompletedTemplate,
} from './index.js';

const PREFS = 'https://app.tarmoto.example/settings/notifications';
const AT = new Date('2026-03-01T08:00:00.000Z');

const cases: Array<[string, { subject: string; html: string; text: string }]> =
  [
    [
      'verification',
      verificationTemplate({
        preferencesUrl: PREFS,
        displayName: 'Riku',
        verifyUrl: 'https://app.tarmoto.example/verify?t=TOKEN',
        expiresInHours: 24,
      }),
    ],
    [
      'password-reset',
      passwordResetTemplate({
        preferencesUrl: PREFS,
        displayName: 'Riku',
        resetUrl: 'https://app.tarmoto.example/reset?t=TOKEN',
        expiresInMinutes: 30,
      }),
    ],
    [
      'password-changed',
      passwordChangedTemplate({
        preferencesUrl: PREFS,
        displayName: 'Riku',
        supportEmail: 'support@tarmoto.app',
        changedAt: AT,
      }),
    ],
    [
      'subscription-confirmed',
      subscriptionConfirmedTemplate({
        preferencesUrl: PREFS,
        displayName: 'Riku',
        planName: 'Pro',
        priceLabel: '€29.99/mo',
        renewsAt: AT,
        manageBillingUrl: 'https://app.tarmoto.example/billing',
      }),
    ],
    [
      'subscription-cancelled',
      subscriptionCancelledTemplate({
        preferencesUrl: PREFS,
        displayName: 'Riku',
        planName: 'Pro',
        endsAt: AT,
        resubscribeUrl: 'https://app.tarmoto.example/billing',
      }),
    ],
    [
      'data-export-ready',
      dataExportReadyTemplate({
        preferencesUrl: PREFS,
        displayName: 'Riku',
        downloadUrl: 'https://app.tarmoto.example/export/abc',
        expiresAt: AT,
      }),
    ],
    [
      'account-deletion-scheduled',
      accountDeletionScheduledTemplate({
        preferencesUrl: PREFS,
        displayName: 'Riku',
        scheduledFor: AT,
        supportEmail: 'support@tarmoto.app',
      }),
    ],
    [
      'trip-invite',
      tripInviteTemplate({
        preferencesUrl: PREFS,
        inviterDisplayName: 'Riku',
        tripTitle: 'Alps Loop',
        joinUrl: 'https://app.tarmoto.example/join/xyz',
        inviteCode: 'ABC123',
        message: 'Come ride!',
      }),
    ],
    [
      'weekly-digest',
      weeklyDigestTemplate({
        preferencesUrl: PREFS,
        displayName: 'Riku',
        rideCount: 4,
        totalKm: 213.7,
        totalMinutes: 372,
        bestQuality: 4.2,
        percentExplored: 38,
        riddenSegments: 512,
        units: 'metric',
        exploreUrl: 'https://app.tarmoto.example/explore',
      }),
    ],
    [
      'account-deletion-completed',
      accountDeletionCompletedTemplate({
        preferencesUrl: PREFS,
        displayName: 'Riku',
        deletedAt: AT,
        supportEmail: 'support@tarmoto.app',
      }),
    ],
    [
      'verification-anon',
      verificationTemplate({
        preferencesUrl: PREFS,
        displayName: '',
        verifyUrl: 'https://app.tarmoto.example/verify?t=TOKEN',
        expiresInHours: 24,
      }),
    ],
    [
      'subscription-confirmed-no-renewal',
      subscriptionConfirmedTemplate({
        preferencesUrl: PREFS,
        displayName: 'Riku',
        planName: 'Pro',
        priceLabel: '€29.99/mo',
        renewsAt: null,
        manageBillingUrl: 'https://app.tarmoto.example/billing',
      }),
    ],
    [
      'subscription-cancelled-ended',
      subscriptionCancelledTemplate({
        preferencesUrl: PREFS,
        displayName: 'Riku',
        planName: 'Pro',
        endsAt: null,
        resubscribeUrl: 'https://app.tarmoto.example/billing',
      }),
    ],
    [
      'weekly-digest-single-no-quality',
      weeklyDigestTemplate({
        preferencesUrl: PREFS,
        displayName: 'Riku',
        rideCount: 1,
        totalKm: 213.7,
        totalMinutes: 372,
        bestQuality: null,
        percentExplored: 38,
        riddenSegments: 512,
        units: 'metric',
        exploreUrl: 'https://app.tarmoto.example/explore',
      }),
    ],
    [
      'trip-invite-no-message',
      tripInviteTemplate({
        preferencesUrl: PREFS,
        inviterDisplayName: 'Riku',
        tripTitle: 'Alps Loop',
        joinUrl: 'https://app.tarmoto.example/join/xyz',
        inviteCode: 'ABC123',
        message: null,
      }),
    ],
  ];

describe('email templates — characterization snapshots', () => {
  it.each(cases)('%s renders stable subject/html/text', (_name, rendered) => {
    expect(rendered.subject).toMatchSnapshot('subject');
    expect(rendered.html).toMatchSnapshot('html');
    expect(rendered.text).toMatchSnapshot('text');
  });
});
