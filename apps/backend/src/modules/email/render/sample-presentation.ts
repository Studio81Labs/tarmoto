import type { EditableTag } from '../presentation/index.js';

type Sample = {
  textVars: Record<string, string>;
  urlVars: Record<string, string>;
};

export const SAMPLE_PRESENTATION: Record<EditableTag, Sample> = {
  'weekly-digest': {
    textVars: {
      displayName: 'Riku',
      rideSummary: '4 rides',
      rideCount: '4',
      distance: '213 km',
      duration: '6h 12m',
      quality: '4.2 / 5',
      riddenSegments: '512',
      percentExplored: '38%',
    },
    urlVars: { exploreUrl: 'https://app.tarmoto.example/explore' },
  },
  'subscription-confirmed': {
    textVars: {
      displayName: 'Riku',
      planName: 'Pro',
      priceLabel: '€29.99/mo',
      renewsText: 'Your next renewal is on Sun, 01 Mar 2026 08:00:00 GMT.',
      renewsDate: 'Sun, 01 Mar 2026 08:00:00 GMT',
    },
    urlVars: { manageBillingUrl: 'https://app.tarmoto.example/billing' },
  },
  'subscription-cancelled': {
    textVars: {
      displayName: 'Riku',
      planName: 'Pro',
      accessText: "You'll keep Pro access until Sun, 01 Mar 2026 08:00:00 GMT.",
    },
    urlVars: { resubscribeUrl: 'https://app.tarmoto.example/billing' },
  },
  'data-export-ready': {
    textVars: {
      displayName: 'Riku',
      expiresText: 'Sun, 01 Mar 2026 08:00:00 GMT',
    },
    urlVars: { downloadUrl: 'https://app.tarmoto.example/export/abc' },
  },
  'account-deletion-scheduled': {
    textVars: {
      displayName: 'Riku',
      scheduledDate: 'Sun, 01 Mar 2026 08:00:00 GMT',
      supportEmail: 'support@tarmoto.app',
    },
    urlVars: {},
  },
  'account-deletion-completed': {
    textVars: {
      displayName: 'Riku',
      deletedDate: 'Sun, 01 Mar 2026 08:00:00 GMT',
      supportEmail: 'support@tarmoto.app',
    },
    urlVars: {},
  },
};
