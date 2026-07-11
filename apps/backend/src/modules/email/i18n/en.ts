import type { Catalog } from '@tarmoto/shared';

// English email copy. Trusted, in-repo, PR-reviewed. May contain inline emphasis
// (<strong>) mirroring the current HTML, but NEVER structural chrome or user data
// (those stay in the template functions, with user data escaped for HTML).
export const en = {
  // --- shared ---
  'common.greeting.named': 'Hi {name},',
  'common.greeting.anon': 'Hi there,',
  'common.html.pasteLink': 'Or paste this link in your browser:',

  // --- verification ---
  'verification.subject': 'Verify your Tarmoto email',
  'verification.preheader': 'Confirm your email to finish setting up Tarmoto.',
  'verification.text.intro':
    'Welcome to Tarmoto — the open road just got smarter.',
  'verification.text.confirmLine':
    'Confirm your email so we can send you trip invites, hazard alerts, and account notices:',
  'verification.html.welcome':
    'Welcome to <strong>Tarmoto</strong> — confirm your email so we can deliver trip invites, hazard alerts, and important account notices.',
  'verification.button': 'Verify email',
  'verification.expiry':
    "This link expires in {hours} hours. If you didn't sign up for Tarmoto, you can ignore this message.",
} as const satisfies Catalog<string>;

export type EmailMessageKey = keyof typeof en;
