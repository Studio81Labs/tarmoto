import { SAMPLE_PRESENTATION } from './sample-presentation.js';
import { EDITABLE_TAGS, TEMPLATE_WHITELIST } from '../presentation/index.js';

describe('SAMPLE_PRESENTATION', () => {
  it.each(EDITABLE_TAGS)('%s sample covers its whitelist keys', (tag) => {
    const s = SAMPLE_PRESENTATION[tag];
    const wl = TEMPLATE_WHITELIST[tag];
    expect(Object.keys(s.textVars).sort()).toEqual([...wl.textVars].sort());
    expect(Object.keys(s.urlVars).sort()).toEqual([...wl.urlVars].sort());
  });
});
