import { IntlMessageFormat } from "intl-messageformat";
import { en } from "./en";

describe("mobile English catalog", () => {
  const entries = Object.entries(en) as [string, string][];

  it("parses every message as ICU", () => {
    const failures = entries
      .filter(([, message]) => {
        try {
          new IntlMessageFormat(message, "en", undefined, { ignoreTag: true });
          return false;
        } catch {
          return true;
        }
      })
      .map(([key]) => key);

    expect(failures).toEqual([]);
  });

  it("avoids ICU apostrophe-quoting traps", () => {
    const offenders = entries
      .filter(
        ([, message]) =>
          message.includes("'{") ||
          message.includes("'}") ||
          message.includes("''"),
      )
      .map(([key]) => key);

    expect(offenders).toEqual([]);
  });

  it("uses an other branch for every plural", () => {
    const offenders = entries
      .filter(
        ([, message]) =>
          (message.match(/,\s*plural,/g)?.length ?? 0) >
          (message.match(/\bother\s*\{/g)?.length ?? 0),
      )
      .map(([key]) => key);

    expect(offenders).toEqual([]);
  });

  it("keeps English source keys and values identical", () => {
    expect(entries.filter(([key, value]) => key !== value)).toEqual([]);
  });

  it("contains no whitespace-only sentence fragments", () => {
    expect(entries.filter(([key]) => key !== key.trim())).toEqual([]);
  });
});
