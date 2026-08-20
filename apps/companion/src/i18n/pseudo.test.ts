import { IntlMessageFormat } from "intl-messageformat";
import { makeTranslator, validateIcuTranslation } from "@tarmoto/shared";
import { en } from "./locales/en";
import {
  PSEUDO_SENTINEL_END,
  PSEUDO_SENTINEL_START,
  pseudoLocalizeCatalog,
  pseudoLocalizeMessage,
} from "./pseudo";

describe("pseudoLocalizeCatalog", () => {
  const pseudo = pseudoLocalizeCatalog(en);
  const entries = Object.entries(pseudo) as [keyof typeof en, string][];

  it("wraps every catalog value in the sentinels, source text intact", () => {
    const broken = entries
      .filter(
        ([key, value]) =>
          value !== `${PSEUDO_SENTINEL_START}${en[key]}${PSEUDO_SENTINEL_END}`,
      )
      .map(([key]) => key);
    expect(broken).toEqual([]);
    expect(entries).toHaveLength(Object.keys(en).length);
  });

  // The wrapper adds literal text OUTSIDE the message only, so every wrapped
  // value must still parse as ICU — messages rendered with `values` go
  // through IntlMessageFormat, and a parse failure would silently degrade to
  // the legacy interpolation path.
  it("keeps every wrapped message valid ICU", () => {
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

  // Stronger than "it parses": the wrapped message must keep the SAME ICU
  // argument schema (names, types, plural/select branches) as its source, so
  // sentinels can never swallow a `{placeholder}` or a plural branch.
  it("preserves each message's ICU argument contract", () => {
    const issues = entries.flatMap(([key, message]) =>
      validateIcuTranslation(en[key], message, "en").map(
        (issue) => `${key}: ${issue}`,
      ),
    );
    expect(issues).toEqual([]);
  });

  it("interpolates placeholders and plurals inside the sentinels", () => {
    const t = makeTranslator<keyof typeof en>({ en: pseudo });
    expect(t("{title}, {status}", { title: "Alps", status: "Draft" })).toBe(
      "⟦ !!! Alps, Draft !!! ⟧",
    );
    expect(
      t(
        "Drafted ≈{distance} through {count, plural, one {# Fun Zone} other {# Fun Zones}} on the way.",
        { distance: "12 km", count: 2 },
      ),
    ).toBe("⟦ !!! Drafted ≈12 km through 2 Fun Zones on the way. !!! ⟧");
  });

  it("does not mutate the source catalog", () => {
    expect(en["Sign in"]).toBe("Sign in");
  });

  // The e2e suite (e2e/pseudo/pseudo-i18n.spec.ts) cannot import app source,
  // so it matches these glyphs by value. Pin them: changing the sentinels
  // must fail here — loudly — instead of silently blinding the smoke test.
  it("keeps the sentinel glyphs the e2e suite matches on stable", () => {
    expect(PSEUDO_SENTINEL_START).toBe("⟦ !!! ");
    expect(PSEUDO_SENTINEL_END).toBe(" !!! ⟧");
    expect(pseudoLocalizeMessage("Sign in")).toBe("⟦ !!! Sign in !!! ⟧");
  });
});

// The activation gate lives at module scope in ./locales/index.ts, so each
// case re-imports the module under stubbed env.
describe("pseudo catalog activation gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadCatalogs() {
    vi.resetModules();
    const { companionCatalogs } = await import("./locales");
    return companionCatalogs;
  }

  it("serves the pseudo catalog when TARMOTO_I18N_PSEUDO=1 outside production", async () => {
    vi.stubEnv("TARMOTO_I18N_PSEUDO", "1");
    const catalogs = await loadCatalogs();
    expect(catalogs.en["Sign in"]).toBe("⟦ !!! Sign in !!! ⟧");
  });

  it("stays inert without the flag", async () => {
    const catalogs = await loadCatalogs();
    expect(catalogs.en["Sign in"]).toBe("Sign in");
  });

  it("stays inert under NODE_ENV=production even with the flag set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TARMOTO_I18N_PSEUDO", "1");
    const catalogs = await loadCatalogs();
    expect(catalogs.en["Sign in"]).toBe("Sign in");
  });
});
