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

  // --- account deletion scheduled ---
  'accountDeletionScheduled.subject':
    'Your Tarmoto account is scheduled for deletion',
  'accountDeletionScheduled.preheader':
    'Your account will be permanently deleted on {date}.',
  'accountDeletionScheduled.text.scheduled':
    'Your Tarmoto account is scheduled for permanent deletion on {date}.',
  'accountDeletionScheduled.html.scheduled':
    'Your Tarmoto account is scheduled for <strong>permanent deletion</strong> on {date}.',
  'accountDeletionScheduled.text.changedMind':
    'Changed your mind? Email {email} before that date and our team will restore your account.',
  'accountDeletionScheduled.html.changedMind':
    'Changed your mind? Email {emailLink} before that date and our team will restore your account.',
  'accountDeletionScheduled.graceWindow':
    "Self-service restore from the app isn't possible during the grace window — the account is locked from sign-in until it's either restored by support or permanently erased.",
  'accountDeletionScheduled.afterDate':
    'After the scheduled date, your personal data will be permanently erased. Anonymized road-quality contributions will remain in the community dataset.',

  // --- trip invite ---
  'tripInvite.subject': '{inviter} invited you to plan "{trip}" on Tarmoto',
  'tripInvite.preheader': '{inviter} invited you to "{trip}".',
  'tripInvite.intro':
    '{inviter} invited you to collaborate on a Tarmoto trip: {trip}.',
  'tripInvite.text.messageBlock': 'Message from {inviter}:',
  'tripInvite.text.openLine': 'Open the trip planner to accept the invite:',
  'tripInvite.text.codeLine':
    "If the link doesn't open automatically, sign in to Tarmoto and enter this invite code on the join screen: {code}",
  'tripInvite.text.noAccount':
    "If you don't have a Tarmoto account yet, you can create one with this email and the invite will be waiting for you.",
  'tripInvite.inviteCodeHtml':
    'Invite code (in case the link doesn\'t open): <strong style="color:#f8fafc;">{code}</strong>',
  'tripInvite.noAccountHtml':
    "Don't have a Tarmoto account? Sign up with this email and the invite will be waiting for you.",
  'tripInvite.button': 'Open trip in Tarmoto',
  // `common.html.pasteLink` (shared section, above) is reused here for the
  // "paste this link" hint — same copy as verification, no need for a
  // duplicate key.

  // --- weekly digest ---
  'digest.subject': 'Your week on Tarmoto — {rideCount} {rideWord}, {distance}',
  'digest.preheader':
    '{rideCount} {rideWord}, {distance} this week on Tarmoto.',
  'digest.greeting.lead': "Here's your week on the road",
  'digest.intro':
    "Exploration: you've now ridden {segments} road sections — {percent}% of your area.",
  'digest.row.rides': 'Rides',
  'digest.row.distance': 'Distance',
  'digest.row.time': 'Time in the saddle',
  'digest.row.quality': 'Best road quality',
  'digest.text.distanceRidden': '{distance} ridden',
  'digest.text.timeInSaddle': '{duration} in the saddle',
  'digest.explored':
    'You\'ve now ridden <strong style="color:#f8fafc;">{segments}</strong> road sections — <strong style="color:#f8fafc;">{percent}%</strong> of your area explored.',
  'digest.button': 'Find your next road',
  'digest.rideWord.one': 'ride',
  'digest.rideWord.other': 'rides',

  // --- account deletion completed ---
  'accountDeletionCompleted.subject': 'Your Tarmoto account has been deleted',
  'accountDeletionCompleted.preheader':
    'Your Tarmoto account has been permanently deleted.',
  'accountDeletionCompleted.text.deleted':
    'Your Tarmoto account was permanently deleted on {date}.',
  'accountDeletionCompleted.html.deleted':
    'Your Tarmoto account was permanently deleted on <strong>{date}</strong>.',
  'accountDeletionCompleted.erased':
    'Personal data has been erased. Anonymized road-quality contributions remain in the community dataset, as outlined in our deletion notice.',
  'accountDeletionCompleted.text.contact':
    "If this wasn't you or you have questions, contact {email}.",
  'accountDeletionCompleted.html.contact': 'Questions? Contact {emailLink}.',

  // --- layout footer (shared chrome) ---
  'layout.footer.transactional.lead':
    'This is a transactional message about your Tarmoto account.',
  'layout.footer.transactional.link': 'Manage notifications',
  'layout.footer.marketing.lead':
    "You're receiving this digest as part of your Tarmoto subscription.",
  'layout.footer.marketing.link': 'Unsubscribe from marketing emails',
  'layout.textFooter.transactional.tagline': 'Tarmoto · transactional email',
  'layout.textFooter.transactional.line': 'Manage notifications: {url}',
  'layout.textFooter.marketing.tagline': 'Tarmoto · weekly digest',
  'layout.textFooter.marketing.lead':
    "You're receiving this as part of your Tarmoto subscription.",
  'layout.textFooter.marketing.unsub':
    'Unsubscribe from marketing emails: {url}',
} as const satisfies Catalog<string>;

export type EmailMessageKey = keyof typeof en;
