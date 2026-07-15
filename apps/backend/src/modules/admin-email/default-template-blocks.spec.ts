import {
  EDITABLE_TAGS,
  TEMPLATE_WHITELIST,
} from '../email/presentation/index.js';
import { validateBlockDocument } from '../email/render/validate-block-document.js';
import { DEFAULT_TEMPLATE_BLOCKS } from './default-template-blocks.js';

describe('DEFAULT_TEMPLATE_BLOCKS', () => {
  it.each(EDITABLE_TAGS)(
    '%s default is a valid, whitelist-clean doc',
    (tag) => {
      // A seed must always be savable/publishable as-is.
      expect(validateBlockDocument(tag, DEFAULT_TEMPLATE_BLOCKS[tag]).ok).toBe(
        true,
      );
    },
  );

  it.each(EDITABLE_TAGS)(
    '%s default has a non-empty subject and >=1 block',
    (tag) => {
      const doc = DEFAULT_TEMPLATE_BLOCKS[tag];
      expect(doc.subject.trim().length).toBeGreaterThan(0);
      expect(doc.blocks.length).toBeGreaterThan(0);
    },
  );

  it('covers exactly the editable tags', () => {
    expect(Object.keys(DEFAULT_TEMPLATE_BLOCKS).sort()).toEqual(
      [...EDITABLE_TAGS].sort(),
    );
    // A guard so the whitelist reference below stays meaningful.
    expect(TEMPLATE_WHITELIST['weekly-digest'].textVars).toContain(
      'displayName',
    );
  });

  // The account-deletion seeds are legal-sensitive: they must carry the same
  // GDPR disclosures the code templates render, so a small admin edit can't
  // silently publish a weaker notice (missing the support-only restore or the
  // "personal data erased / anonymized contributions remain" wording).
  it('account-deletion seeds retain the GDPR legal disclosures', () => {
    const bodyOf = (
      tag: 'account-deletion-scheduled' | 'account-deletion-completed',
    ): string =>
      DEFAULT_TEMPLATE_BLOCKS[tag].blocks
        .map((b) =>
          b.type === 'heading' || b.type === 'paragraph' ? b.text : '',
        )
        .join(' ');

    const scheduled = bodyOf('account-deletion-scheduled');
    expect(scheduled).toContain(
      "Self-service restore from the app isn't possible",
    );
    expect(scheduled).toContain('personal data will be permanently erased');
    expect(scheduled).toContain('Anonymized road-quality contributions');

    const completed = bodyOf('account-deletion-completed');
    expect(completed).toContain('Personal data has been erased');
    expect(completed).toContain('Anonymized road-quality contributions remain');
  });

  it.each(EDITABLE_TAGS)(
    '%s seed greeting is anon-safe (no dangling {displayName} salutation)',
    (tag) => {
      const body = DEFAULT_TEMPLATE_BLOCKS[tag].blocks
        .map((b) =>
          b.type === 'heading' || b.type === 'paragraph' ? b.text : '',
        )
        .join(' ');
      // A bare "Hi {displayName}" renders "Hi " for users with no display name;
      // the code templates branch to an anonymous greeting instead.
      expect(body).not.toContain('Hi {displayName}');
    },
  );
});
