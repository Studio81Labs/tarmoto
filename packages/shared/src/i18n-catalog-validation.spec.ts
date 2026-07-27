import { describe, expect, it } from "vitest";
import { findUntranslatedCatalogEntries, validateIcuTranslation } from "./i18n";

describe("validateIcuTranslation", () => {
  it("accepts reordered arguments and complete target-locale plurals", () => {
    expect(
      validateIcuTranslation(
        "{name} has {count, plural, one {# ride} other {# rides}}",
        "{count, plural, one {# jízdu} few {# jízdy} many {# jízdy} other {# jízd}} má {name}",
        "cs",
      ),
    ).toEqual([]);
  });

  it("rejects renamed or retyped arguments", () => {
    expect(
      validateIcuTranslation(
        "{name} rode {distance, number}",
        "{rider} ujel {distance}",
        "cs",
      ),
    ).toEqual([
      "ICU argument schema differs (expected distance:number, name:argument; received distance:argument, rider:argument)",
    ]);
  });

  it("rejects changed select tokens and plural kinds", () => {
    expect(
      validateIcuTranslation(
        "{kind, select, road {Road} trail {Trail} other {Other}} · {rank, plural, one {# place} other {# places}}",
        "{kind, select, road {Silnice} path {Stezka} other {Jiné}} · {rank, selectordinal, one {#. místo} few {#. místo} other {#. místo}}",
        "cs",
      ),
    ).toEqual([
      "ICU argument schema differs (expected kind:select[other|road|trail], rank:plural:cardinal[]; received kind:select[other|path|road], rank:plural:ordinal[])",
    ]);
  });

  it("requires every plural category used by the target locale", () => {
    expect(
      validateIcuTranslation(
        "{count, plural, one {# ride} other {# rides}}",
        "{count, plural, one {# jízda} other {# jízd}}",
        "cs",
      ),
    ).toEqual([
      "message.count is missing cs cardinal plural branches: few, many",
    ]);
  });

  it("rejects select arguments without an other branch", () => {
    expect(
      validateIcuTranslation(
        "{kind, select, road {Road} other {Unknown}}",
        "{kind, select, road {Silnice}}",
        "cs",
      ),
    ).toEqual(["Translation is invalid ICU: MISSING_OTHER_CLAUSE"]);
  });
});

describe("findUntranslatedCatalogEntries", () => {
  const source = {
    Save: "Save",
    Tarmoto: "Tarmoto",
    "{start} → {end}": "{start} → {end}",
  } as const;

  it("rejects copied source values even when every key is present", () => {
    expect(findUntranslatedCatalogEntries(source, source)).toEqual([
      "Save",
      "Tarmoto",
      "{start} → {end}",
    ]);
  });

  it("requires exact invariants to be reviewed and allowlisted", () => {
    expect(
      findUntranslatedCatalogEntries(
        source,
        {
          Save: "Uložit",
          Tarmoto: "Tarmoto",
          "{start} → {end}": "{start} → {end}",
        },
        new Set(["Tarmoto", "{start} → {end}"]),
      ),
    ).toEqual([]);
  });
});
