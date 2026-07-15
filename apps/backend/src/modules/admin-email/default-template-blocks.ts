import type { EmailBlockDocument } from '@tarmoto/shared';
import type { EditableTag } from '../email/presentation/index.js';

/**
 * Per-tag starting block documents for the admin editor. Served by
 * `AdminEmailTemplateService.get()` when a (tag, locale) has no override yet,
 * so the admin edits a real starting point instead of a blank slate. These
 * APPROXIMATE each current code email (fixed block vocabulary, different
 * renderer → not byte-identical) and reference ONLY each tag's whitelisted
 * vars — `default-template-blocks.spec.ts` proves both.
 */
export const DEFAULT_TEMPLATE_BLOCKS: Record<EditableTag, EmailBlockDocument> =
  {
    'weekly-digest': {
      subject: 'Your week — {rideSummary}',
      blocks: [
        { type: 'heading', text: 'Hi {displayName}' },
        { type: 'paragraph', text: "Here's your week on Tarmoto." },
        { type: 'stat-row', label: 'Rides', value: '{rideSummary}' },
        { type: 'stat-row', label: 'Distance', value: '{distance}' },
        { type: 'stat-row', label: 'Time in the saddle', value: '{duration}' },
        { type: 'stat-row', label: 'Best road quality', value: '{quality}' },
        {
          type: 'paragraph',
          text: "You've ridden {riddenSegments} road segments — {percentExplored} of your area explored.",
        },
        { type: 'button', label: 'Explore your map', urlVar: 'exploreUrl' },
      ],
    },
    'subscription-confirmed': {
      subject: 'Your Tarmoto {planName} subscription is active',
      blocks: [
        { type: 'heading', text: 'Hi {displayName}' },
        { type: 'paragraph', text: "You're now on Tarmoto {planName}." },
        { type: 'stat-row', label: 'Plan', value: '{planName}' },
        { type: 'stat-row', label: 'Price', value: '{priceLabel}' },
        { type: 'paragraph', text: '{renewsText}' },
        { type: 'button', label: 'Manage billing', urlVar: 'manageBillingUrl' },
      ],
    },
    'subscription-cancelled': {
      subject: 'Your Tarmoto {planName} subscription is cancelled',
      blocks: [
        { type: 'heading', text: 'Hi {displayName}' },
        {
          type: 'paragraph',
          text: 'Your {planName} subscription has been cancelled.',
        },
        { type: 'paragraph', text: '{accessText}' },
        { type: 'button', label: 'Resubscribe', urlVar: 'resubscribeUrl' },
      ],
    },
    'data-export-ready': {
      subject: 'Your Tarmoto data export is ready',
      blocks: [
        { type: 'heading', text: 'Hi {displayName}' },
        { type: 'paragraph', text: 'Your data export is ready to download.' },
        { type: 'paragraph', text: 'This link expires {expiresText}.' },
        { type: 'button', label: 'Download your data', urlVar: 'downloadUrl' },
      ],
    },
    // Legal-sensitive: the seed mirrors the code template's GDPR wording (the
    // support-only restore, and the "personal data erased / anonymized
    // road-quality contributions remain" disclosure) so a small admin edit
    // can't accidentally publish a notice that drops those disclosures.
    'account-deletion-scheduled': {
      subject: 'Your Tarmoto account is scheduled for deletion',
      blocks: [
        { type: 'heading', text: 'Hi {displayName}' },
        {
          type: 'paragraph',
          text: 'Your Tarmoto account is scheduled for permanent deletion on {scheduledDate}.',
        },
        {
          type: 'paragraph',
          text: 'Changed your mind? Email {supportEmail} before that date and our team will restore your account.',
        },
        {
          type: 'paragraph',
          text: "Self-service restore from the app isn't possible during the grace window — the account is locked from sign-in until it's either restored by support or permanently erased.",
        },
        {
          type: 'paragraph',
          text: 'After the scheduled date, your personal data will be permanently erased. Anonymized road-quality contributions will remain in the community dataset.',
        },
      ],
    },
    'account-deletion-completed': {
      subject: 'Your Tarmoto account has been deleted',
      blocks: [
        { type: 'heading', text: 'Hi {displayName}' },
        {
          type: 'paragraph',
          text: 'Your Tarmoto account was permanently deleted on {deletedDate}.',
        },
        {
          type: 'paragraph',
          text: 'Personal data has been erased. Anonymized road-quality contributions remain in the community dataset, as outlined in our deletion notice.',
        },
        {
          type: 'paragraph',
          text: "If this wasn't you or you have questions, contact {supportEmail}.",
        },
      ],
    },
  };
