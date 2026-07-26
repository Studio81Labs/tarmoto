import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const fixturePath = resolve(
  process.cwd(),
  "src/screens/EmergencyContactsScreen.tsx",
);
const eslintBin = resolve(process.cwd(), "node_modules/eslint/bin/eslint.js");

function guardMessages(source: string) {
  const result = spawnSync(
    process.execPath,
    [eslintBin, "--stdin", "--stdin-filename", fixturePath, "--format", "json"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      input: source,
    },
  );
  if (result.error || result.status === null || result.status > 1) {
    throw result.error ?? new Error(result.stderr);
  }
  const reports = JSON.parse(result.stdout) as Array<{
    messages: Array<{ ruleId: string | null; message: string }>;
  }>;
  return (reports[0]?.messages ?? []).filter(
    ({ ruleId }) => ruleId === "no-restricted-syntax",
  );
}

function localizationMessages(source: string, rule: string) {
  const result = spawnSync(
    process.execPath,
    [eslintBin, "--stdin", "--stdin-filename", fixturePath, "--format", "json"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      input: source,
    },
  );
  if (result.error || result.status === null || result.status > 1) {
    throw result.error ?? new Error(result.stderr);
  }
  const reports = JSON.parse(result.stdout) as Array<{
    messages: Array<{ ruleId: string | null; message: string }>;
  }>;
  return (reports[0]?.messages ?? []).filter(({ ruleId }) => ruleId === rule);
}

describe("mobile indirect display-copy lint guard", () => {
  it.each([
    'const title = active ? "Add contact" : "Edit contact";',
    "const fallbackName = `Ride on ${date}`;",
    'const actionLabel = active ? "Subscribe" : "Manage";',
  ])("rejects uncataloged intermediate copy: %s", (declaration) => {
    expect(guardMessages(declaration)).not.toHaveLength(0);
  });

  it("allows translated intermediate copy", () => {
    expect(
      guardMessages(
        'const title = active ? translate("Add contact") : translate("Edit contact");',
      ),
    ).toHaveLength(0);
  });

  it.each([
    "function tierLabel(tier) { const key = labels[tier]; return key ? translate(key) : tier; }",
    "function categoryDisplay(place) { return place.categoryKey ? translate(place.categoryKey) : place.category; }",
    "const sourceLabel = (source) => source;",
    "const view = translate('{surface}', { surface: reading.surface });",
    "const view = translate('{season}', { season });",
  ])("rejects raw semantic display fallbacks: %s", (source) => {
    expect(guardMessages(source)).not.toHaveLength(0);
  });

  it("rejects uncataloged banner state", () => {
    expect(
      guardMessages('setStatusBanner(active ? "Queued for upload" : null);'),
    ).not.toHaveLength(0);
  });

  it("rejects uncataloged copy nested in state objects", () => {
    expect(
      guardMessages(
        'setList((state) => ({ ...state, error: "Load failed" }));',
      ),
    ).not.toHaveLength(0);
  });

  it("rejects uncataloged generic message properties", () => {
    expect(
      guardMessages('const next = { message: "Could not save" };'),
    ).not.toHaveLength(0);
  });

  it.each([
    'setError(error.message || "Could not save");',
    'const subtitle = active ? "Live now" : "Offline";',
    'const helpText = active ? `Showing ${count}` : "Nothing to show";',
  ])("rejects companion-parity copy bypasses: %s", (source) => {
    expect(guardMessages(source)).not.toHaveLength(0);
  });

  it("rejects directly rendered numeric display values", () => {
    expect(
      guardMessages("const view = <Text>{item.count}</Text>;"),
    ).not.toHaveLength(0);
  });

  it("rejects uncataloged copy in secondary display props", () => {
    expect(
      guardMessages(
        "const view = <Metric delta={`${missingCount} unavailable`} />;",
      ),
    ).not.toHaveLength(0);
  });

  it.each([
    'import React from "react"; import { t as translate } from "@/i18n"; const Row = React.memo(() => <Text>{translate("Ready")}</Text>);',
    'import React from "react"; import { getFormatters } from "@/format"; const Row = React.memo(() => <Text>{getFormatters().integer(1)}</Text>);',
  ])("rejects global locale seams across memo boundaries", (source) => {
    expect(guardMessages(source)).not.toHaveLength(0);
  });

  it("allows context-bound locale hooks across memo boundaries", () => {
    expect(
      guardMessages(
        'import React from "react"; import { useTranslation } from "@/i18n/I18nProvider"; const Row = React.memo(() => { const t = useTranslation(); return <Text>{t("Ready")}</Text>; });',
      ),
    ).toHaveLength(0);
  });

  it("rejects raw copy in companion-parity component props", () => {
    expect(
      guardMessages('const view = <Banner headline="Ride saved" />;'),
    ).not.toHaveLength(0);
  });

  it.each([
    "const view = <Text>{label.toUpperCase()}</Text>;",
    "const display = label.toLocaleLowerCase();",
  ])("rejects display casing without an active locale: %s", (source) => {
    expect(guardMessages(source)).not.toHaveLength(0);
  });

  it("allows locale-bound display casing", () => {
    expect(
      guardMessages("const display = label.toLocaleUpperCase(locale);"),
    ).toHaveLength(0);
  });

  it("rejects sentences assembled from translated fragments", () => {
    expect(
      localizationMessages(
        'const view = <Text>{translate("Location")} {coordinates}</Text>;',
        "tarmoto-localization/no-translated-fragments",
      ),
    ).not.toHaveLength(0);
  });

  it("rejects sentences assembled inside JSX fragments", () => {
    expect(
      localizationMessages(
        'const view = <>{translate("Updated")} {formattedTime}</>;',
        "tarmoto-localization/no-translated-fragments",
      ),
    ).not.toHaveLength(0);
  });

  it("rejects styled translated fragments inside JSX fragments", () => {
    expect(
      localizationMessages(
        'const view = <><Text style={styles.bold}>{translate("Updated")}</Text> {formattedTime}</>;',
        "tarmoto-localization/no-translated-fragments",
      ),
    ).not.toHaveLength(0);
  });

  it("allows fragments that group independent translated Text blocks", () => {
    expect(
      localizationMessages(
        'const view = <><Text>{translate("Title")}</Text><Text>{translate("Description")}</Text></>;',
        "tarmoto-localization/no-translated-fragments",
      ),
    ).toHaveLength(0);
  });

  it.each([
    'const view = <Text>{translate("Updated") + formattedTime}</Text>;',
    'const view = <Text>{`${translate("Updated")} ${formattedTime}`}</Text>;',
  ])("rejects translated composition inside one JSX expression", (source) => {
    expect(
      localizationMessages(
        source,
        "tarmoto-localization/no-translated-fragments",
      ),
    ).not.toHaveLength(0);
  });

  it("rejects translated composition nested in conditional branches", () => {
    expect(
      localizationMessages(
        'const view = <Text>{updated ? translate("Updated") + time : translate("Created") + time}</Text>;',
        "tarmoto-localization/no-translated-fragments",
      ),
    ).not.toHaveLength(0);
  });

  it.each([
    'const view = <Text>{translate("Updated").concat(time)}</Text>;',
    'const view = <Text>{[translate("Updated"), time].join(" ")}</Text>;',
    'const view = <Text>{[translate("Updated"), " ", time].filter(Boolean)}</Text>;',
  ])("rejects translated composition in call receivers", (source) => {
    expect(
      localizationMessages(
        source,
        "tarmoto-localization/no-translated-fragments",
      ),
    ).not.toHaveLength(0);
  });

  it.each([
    'const view = <Text>{[translate("Updated"), " ", time].map(String)}</Text>;',
    'const view = <Text>{[translate("Updated"), " ", time].map((value) => value)}</Text>;',
  ])(
    "rejects mapped receivers whose callback preserves translated fragments",
    (source) => {
      expect(
        localizationMessages(
          source,
          "tarmoto-localization/no-translated-fragments",
        ),
      ).not.toHaveLength(0);
    },
  );

  it("rejects translated fragments split across helper arguments", () => {
    expect(
      localizationMessages(
        'const view = <Text>{joinParts(translate("Updated"), time)}</Text>;',
        "tarmoto-localization/no-translated-fragments",
      ),
    ).not.toHaveLength(0);
  });

  it.each([
    'const view = <Text>{items.map((item) => translate("Updated") + item.time)}</Text>;',
    'const view = <Text>{items.flatMap((item) => { return `${translate("Updated")} ${item.time}`; })}</Text>;',
  ])(
    "rejects translated composition returned by rendered callbacks",
    (source) => {
      expect(
        localizationMessages(
          source,
          "tarmoto-localization/no-translated-fragments",
        ),
      ).not.toHaveLength(0);
    },
  );

  it("rejects translated composition in accessibility attributes", () => {
    expect(
      localizationMessages(
        'const view = <Button accessibilityLabel={`${translate("Updated")} ${formattedTime}`} />;',
        "tarmoto-localization/no-translated-fragments",
      ),
    ).not.toHaveLength(0);
  });

  it("rejects translated fragments nested in inline JSX", () => {
    expect(
      localizationMessages(
        'const view = <Text><Text><Text>{translate("Updated")}</Text></Text> {formattedTime}</Text>;',
        "tarmoto-localization/no-translated-fragments",
      ),
    ).not.toHaveLength(0);
  });

  it("allows independent translated atoms separated by a middle dot", () => {
    expect(
      localizationMessages(
        'const view = <Text>{translate("Distance")} · {formattedDistance}</Text>;',
        "tarmoto-localization/no-translated-fragments",
      ),
    ).toHaveLength(0);
  });

  it("rejects translated fragments within separator-delimited atoms", () => {
    expect(
      localizationMessages(
        'const view = <Text>{translate("Updated")} {time} · {translate("by")} {author}</Text>;',
        "tarmoto-localization/no-translated-fragments",
      ),
    ).not.toHaveLength(0);
  });

  it("rejects visible numeric JSX text", () => {
    expect(
      localizationMessages(
        "const view = <Text>01</Text>;",
        "tarmoto-localization/no-visible-numeric-jsx-text",
      ),
    ).not.toHaveLength(0);
  });

  it("rejects visible numeric JSX expression literals", () => {
    expect(
      localizationMessages(
        "const view = <Text>{2026}</Text>;",
        "tarmoto-localization/no-visible-numeric-jsx-text",
      ),
    ).not.toHaveLength(0);
  });

  it.each([
    "const view = <Stat value={`${remainingManeuvers}`} />;",
    "const view = <Metric value={`${trip.num_days}`} />;",
    "const view = <Text>{count > 0 ? ` ${count}` : ''}</Text>;",
    "const view = <Metric delta={missingCount} />;",
  ])("rejects unformatted numeric references in display output", (source) => {
    expect(
      localizationMessages(
        source,
        "tarmoto-localization/no-visible-numeric-jsx-text",
      ),
    ).not.toHaveLength(0);
  });

  it("allows numeric display references passed through a regional formatter", () => {
    expect(
      localizationMessages(
        "const view = <Stat value={getFormatters().integer(remainingManeuvers)} />;",
        "tarmoto-localization/no-visible-numeric-jsx-text",
      ),
    ).toHaveLength(0);
  });

  it.each([
    'const view = <Text>{"2026"}</Text>;',
    "const view = <Text>{compact ? 1 : 2026}</Text>;",
  ])("rejects nested visible numeric JSX literals", (source) => {
    expect(
      localizationMessages(
        source,
        "tarmoto-localization/no-visible-numeric-jsx-text",
      ),
    ).not.toHaveLength(0);
  });

  it("allows numeric arguments passed through a regional formatter", () => {
    expect(
      localizationMessages(
        "const view = <Text>{format.integer(2026)}</Text>;",
        "tarmoto-localization/no-visible-numeric-jsx-text",
      ),
    ).toHaveLength(0);
  });

  it("rejects numeric literals hidden in translator keys", () => {
    expect(
      localizationMessages(
        'const view = <Text>{translate("2024")}</Text>;',
        "tarmoto-localization/no-visible-numeric-jsx-text",
      ),
    ).not.toHaveLength(0);
  });

  it("allows numeric ICU values in translator calls", () => {
    expect(
      localizationMessages(
        'const view = <Text>{translate("{value0}", { value0: 2024 })}</Text>;',
        "tarmoto-localization/no-visible-numeric-jsx-text",
      ),
    ).toHaveLength(0);
  });

  it("rejects numeric literals passed to non-formatter calls", () => {
    expect(
      localizationMessages(
        "const view = <Text>{String(2026)}</Text>;",
        "tarmoto-localization/no-visible-numeric-jsx-text",
      ),
    ).not.toHaveLength(0);
  });

  it.each([
    "const view = <Text>{formatRaw(2026)}</Text>;",
    "const view = <Text>{format.raw(2026)}</Text>;",
    "const view = <Text>{unknown.format(2026)}</Text>;",
  ])(
    "rejects numeric literals passed to unverified formatter APIs",
    (source) => {
      expect(
        localizationMessages(
          source,
          "tarmoto-localization/no-visible-numeric-jsx-text",
        ),
      ).not.toHaveLength(0);
    },
  );

  it("allows verified standalone regional-formatting helpers", () => {
    expect(
      localizationMessages(
        "const view = <Text>{formatCount(2026, locale)}</Text>;",
        "tarmoto-localization/no-visible-numeric-jsx-text",
      ),
    ).toHaveLength(0);
  });

  it("rejects numeric literals in non-formatter call receivers", () => {
    expect(
      localizationMessages(
        "const view = <Text>{(2026).toString()}</Text>;",
        "tarmoto-localization/no-visible-numeric-jsx-text",
      ),
    ).not.toHaveLength(0);
  });

  it("rejects numeric literals preserved by rendered collection calls", () => {
    expect(
      localizationMessages(
        "const view = <Text>{[2026].filter(Boolean)}</Text>;",
        "tarmoto-localization/no-visible-numeric-jsx-text",
      ),
    ).not.toHaveLength(0);
  });

  it.each([
    "const view = <Text>{items.map((_, index) => index + 1)}</Text>;",
    "const view = <Text>{items.flatMap((_, index) => { return index + 1; })}</Text>;",
  ])("rejects numeric values returned by rendered callbacks", (source) => {
    expect(
      localizationMessages(
        source,
        "tarmoto-localization/no-visible-numeric-jsx-text",
      ),
    ).not.toHaveLength(0);
  });

  it.each([
    "const view = <Button accessibilityLabel={String(2026)} />;",
    'const view = <Button accessibilityLabel={"2026"} />;',
    'const view = <Button accessibilityLabel="2026" />;',
  ])("rejects numeric accessibility attributes", (source) => {
    expect(
      localizationMessages(
        source,
        "tarmoto-localization/no-visible-numeric-jsx-text",
      ),
    ).not.toHaveLength(0);
  });

  it("allows numeric literals used only to build structural JSX", () => {
    expect(
      localizationMessages(
        "const view = <Text>{[1, 2, 3].map(renderItem)}</Text>;",
        "tarmoto-localization/no-visible-numeric-jsx-text",
      ),
    ).toHaveLength(0);
  });

  it.each([
    "value.toLowerCase()",
    "value.toUpperCase()",
    "value.toLocaleLowerCase(locale)",
    "value.toLocaleUpperCase(locale)",
  ])(
    "rejects locale-insensitive rider search normalization via %s",
    (normalization) => {
      expect(
        localizationMessages(
          `function matchSearch(value, locale) { return ${normalization}; }`,
          "tarmoto-localization/no-locale-insensitive-search",
        ),
      ).not.toHaveLength(0);
    },
  );
});
