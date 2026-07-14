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
});
