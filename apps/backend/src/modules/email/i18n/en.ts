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

  // --- password reset ---
  'passwordReset.subject': 'Reset your Tarmoto password',
  'passwordReset.preheader': 'Use this link to set a new Tarmoto password.',
  'passwordReset.text.intro':
    'Someone (hopefully you) asked to reset your Tarmoto password. Use the link below to choose a new one:',
  'passwordReset.html.intro':
    'We received a request to reset your password. Tap the button below to choose a new one.',
  'passwordReset.button': 'Reset password',
  'passwordReset.expiryText':
    "This link expires in {minutes} minutes and can only be used once. If you didn't request this, ignore the message — your password stays the same.",
  'passwordReset.expiryHtml':
    'This link expires in <strong>{minutes} minutes</strong> and can only be used once.',
  'passwordReset.noRequest':
    "If you didn't request this, ignore the message — your password stays the same.",

  // --- password changed ---
  'passwordChanged.subject': 'Your Tarmoto password was changed',
  'passwordChanged.preheader': 'Confirmation that your password was changed.',
  'passwordChanged.text.body':
    'Your Tarmoto password was just changed ({when}). If this was you, no action is needed.',
  'passwordChanged.html.changed': 'Your Tarmoto password was just changed.',
  'passwordChanged.when': 'When: <strong>{when}</strong>',
  'passwordChanged.html.ifYou': 'If this was you, no action is needed.',
  'passwordChanged.text.contact':
    "If you didn't change your password, contact us immediately at {email}. Your account may be at risk.",
  'passwordChanged.html.contact':
    "If you didn't change your password, contact us immediately at {emailLink}.",

  // --- subscription confirmed ---
  'subscriptionConfirmed.subject': 'Your Tarmoto {plan} subscription is active',
  'subscriptionConfirmed.preheader':
    'Your Tarmoto {plan} subscription is active.',
  'subscriptionConfirmed.welcome':
    'Welcome to <strong>Tarmoto {plan}</strong> — your subscription is now active.',
  'subscriptionConfirmed.text.welcome':
    'Welcome to Tarmoto {plan} — your subscription is now active.',
  'subscriptionConfirmed.table.plan': 'Plan',
  'subscriptionConfirmed.table.price': 'Price',
  'subscriptionConfirmed.table.renewal': 'Next renewal',
  'subscriptionConfirmed.text.renews': 'Your next renewal is on {date}.',
  'subscriptionConfirmed.text.noRenew': 'Your subscription is active.',
  'subscriptionConfirmed.text.manageIntro':
    'Manage your billing or cancel anytime',
  'subscriptionConfirmed.manageButton': 'Manage billing',

  // --- subscription cancelled ---
  'subscriptionCancelled.subject':
    'Your Tarmoto {plan} subscription was cancelled',
  'subscriptionCancelled.preheader':
    'Your Tarmoto {plan} subscription was cancelled.',
  'subscriptionCancelled.html.cancelled':
    'Your <strong>Tarmoto {plan}</strong> subscription has been cancelled.',
  'subscriptionCancelled.text.cancelled':
    'Your Tarmoto {plan} subscription has been cancelled.',
  'subscriptionCancelled.accessKept': "You'll keep {plan} access until {date}.",
  'subscriptionCancelled.accessEnded': 'Your {plan} access has ended.',
  'subscriptionCancelled.text.resubscribeIntro':
    'Changed your mind? Resubscribe anytime',
  'subscriptionCancelled.resubscribeButton': 'Resubscribe',

  // --- data export ready ---
  'dataExportReady.subject': 'Your Tarmoto data export is ready',
  'dataExportReady.preheader': 'Your Tarmoto data export is ready to download.',
  'dataExportReady.text.ready':
    'Your Tarmoto data export is ready. Download it here:',
  'dataExportReady.html.ready': 'Your Tarmoto data export is ready.',
  'dataExportReady.button': 'Download export',
  'dataExportReady.text.expiry': 'The link expires on {date}.',
  'dataExportReady.html.expiry': 'The link expires on <strong>{date}</strong>.',
} as const satisfies Catalog<string>;

export type EmailMessageKey = keyof typeof en;
