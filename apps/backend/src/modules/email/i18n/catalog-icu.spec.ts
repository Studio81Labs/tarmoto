import { IntlMessageFormat } from 'intl-messageformat';
import { en } from './en.js';

// Engine-readiness guard for the email catalog (content is out of scope —
// this asserts parseability, not copy). See companion catalog.test.ts for
// the rationale on the apostrophe rules.
describe('email en catalog ICU validity', () => {
  const entries = Object.entries(en) as [string, string][];

  it('parses every message as ICU', () => {
    const failures = entries
      .filter(([, message]) => {
        try {
          new IntlMessageFormat(message, 'en', undefined, { ignoreTag: true });
          return false;
        } catch {
          return true;
        }
      })
      .map(([key]) => key);
    expect(failures).toEqual([]);
  });

  it('contains no ICU apostrophe-quoting sequences', () => {
    const offenders = entries
      .filter(
        ([, m]) => m.includes("'{") || m.includes("'}") || m.includes("''"),
      )
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });
});
