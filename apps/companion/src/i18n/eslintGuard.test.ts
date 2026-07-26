import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const fixturePath = resolve(
  process.cwd(),
  "src/app/(dashboard)/settings/subscription/page.tsx",
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

describe("companion indirect display-copy lint guard", () => {
  it.each([
    "function helper(t: Translate = englishTranslate) { return t('Ready'); }",
    "function helper(t?: Translate) { return t?.('Ready'); }",
    "interface Options { translate?: Translate }",
  ])("rejects optional companion translator dependencies: %s", (source) => {
    expect(guardMessages(source)).not.toHaveLength(0);
  });

  it.each([
    'const actionLabel = active ? "Subscribe" : "Manage";',
    "const fallbackName = `Ride on ${date}`;",
    "const displayName = name ?? `Ride on ${date}`;",
  ])("rejects uncataloged intermediate copy: %s", (declaration) => {
    expect(guardMessages(declaration)).not.toHaveLength(0);
  });

  it("allows translated intermediate copy", () => {
    expect(
      guardMessages(
        'const actionLabel = active ? t("Subscribe") : t("Manage");',
      ),
    ).toHaveLength(0);
  });

  it.each([
    "function roleLabel(role, t) { if (role === 'owner') return t('Owner'); return role; }",
    "function surfaceLabel(surface, t) { const key = labels[surface]; return key ? t(key) : surface; }",
    "function categoryDisplay(place, t) { return place.categoryKey ? t(place.categoryKey) : place.category; }",
    "const sourceLabel = (source) => source;",
    "const view = t('{category}', { category: poi.category });",
    "const view = t('{season}', { season });",
    "const view = t('{status}', { status });",
    "const view = translate('{status}', { status: trip.status });",
  ])("rejects raw semantic display fallbacks: %s", (source) => {
    expect(guardMessages(source)).not.toHaveLength(0);
  });

  it("rejects uncataloged copy nested in state objects", () => {
    expect(
      guardMessages(
        'setList((state) => ({ ...state, error: "Load failed" }));',
      ),
    ).not.toHaveLength(0);
  });

  it("rejects directly rendered numeric display values", () => {
    expect(
      guardMessages("const view = <span>{entry.rank}</span>;"),
    ).not.toHaveLength(0);
  });

  it("rejects uncataloged copy in secondary display props", () => {
    expect(
      guardMessages(
        "const view = <MetricTile delta={`${missingCount} unavailable`} />;",
      ),
    ).not.toHaveLength(0);
  });

  it("rejects numeric branches hidden inside a rendered fallback", () => {
    expect(
      guardMessages("const view = <span>{forcedDays ?? t('Auto')}</span>;"),
    ).not.toHaveLength(0);
  });

  it.each([
    'const view = <Line name="This segment" />;',
    'const view = <Tooltip formatter={() => [value, "Distance"]} />;',
    "const view = <YAxis tickFormatter={(value) => Math.round(value)} />;",
    "const view = <span>{stat.key}</span>;",
  ])("rejects chart/config display bypasses: %s", (source) => {
    expect(guardMessages(source)).not.toHaveLength(0);
  });

  it.each([
    "const view = <span>{label.toUpperCase()}</span>;",
    "const display = label.toLocaleLowerCase();",
    "const unit = format.splitDistanceKm(1).unit.toUpperCase();",
  ])("rejects display casing without an active locale: %s", (source) => {
    expect(guardMessages(source)).not.toHaveLength(0);
  });

  it("allows locale-bound display casing", () => {
    expect(
      guardMessages("const display = label.toLocaleUpperCase(locale);"),
    ).toHaveLength(0);
  });

  it("rejects locale-sensitive casing for measurement-unit tokens", () => {
    expect(
      guardMessages(
        "const unit = format.splitDistanceKm(1).unit.toLocaleUpperCase(locale);",
      ),
    ).not.toHaveLength(0);
  });

  it("allows the invariant measurement-unit label helper", () => {
    expect(
      guardMessages('const unit = format.unitLabel("distance");'),
    ).toHaveLength(0);
  });

  it("rejects sentences assembled from translated fragments", () => {
    expect(
      localizationMessages(
        'const view = <p>{t("Updated")} {formattedTime}</p>;',
        "tarmoto-localization/no-translated-fragments",
      ),
    ).not.toHaveLength(0);
  });

  it("rejects sentences assembled inside JSX fragments", () => {
    expect(
      localizationMessages(
        'const view = <>{t("Updated")} {formattedTime}</>;',
        "tarmoto-localization/no-translated-fragments",
      ),
    ).not.toHaveLength(0);
  });

  it("rejects styled translated fragments inside JSX fragments", () => {
    expect(
      localizationMessages(
        'const view = <><strong>{t("Updated")}</strong> {formattedTime}</>;',
        "tarmoto-localization/no-translated-fragments",
      ),
    ).not.toHaveLength(0);
  });

  it("rejects translated fragments followed by styled dynamic text", () => {
    expect(
      localizationMessages(
        'const view = <>{t("Updated")} <strong>{formattedTime}</strong></>;',
        "tarmoto-localization/no-translated-fragments",
      ),
    ).not.toHaveLength(0);
  });

  it.each(["div", "li", "td"])(
    "rejects translated fragments in generic <%s> text containers",
    (element) => {
      expect(
        localizationMessages(
          `const view = <${element}>{t("Updated")} {formattedTime}</${element}>;`,
          "tarmoto-localization/no-translated-fragments",
        ),
      ).not.toHaveLength(0);
    },
  );

  it("rejects translated fragments in flex text runs", () => {
    expect(
      localizationMessages(
        'const view = <div className="flex">{t("Updated")} {formattedTime}</div>;',
        "tarmoto-localization/no-translated-fragments",
      ),
    ).not.toHaveLength(0);
  });

  it("allows independent translated elements inside flex layouts", () => {
    expect(
      localizationMessages(
        'const view = <div className="flex"><span>{t("Title")}</span><span>{t("Description")}</span></div>;',
        "tarmoto-localization/no-translated-fragments",
      ),
    ).toHaveLength(0);
  });

  it.each([
    'const view = <p>{t("Updated") + formattedTime}</p>;',
    'const view = <p>{`${t("Updated")} ${formattedTime}`}</p>;',
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
        'const view = <p>{updated ? t("Updated") + time : t("Created") + time}</p>;',
        "tarmoto-localization/no-translated-fragments",
      ),
    ).not.toHaveLength(0);
  });

  it.each([
    'const view = <p>{t("Updated").concat(time)}</p>;',
    'const view = <p>{[t("Updated"), time].join(" ")}</p>;',
    'const view = <p>{[t("Updated"), " ", time].filter(Boolean)}</p>;',
  ])("rejects translated composition in call receivers", (source) => {
    expect(
      localizationMessages(
        source,
        "tarmoto-localization/no-translated-fragments",
      ),
    ).not.toHaveLength(0);
  });

  it.each([
    'const view = <p>{[t("Updated"), " ", time].map(String)}</p>;',
    'const view = <p>{[t("Updated"), " ", time].map((value) => value)}</p>;',
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
        'const view = <p>{joinParts(t("Updated"), time)}</p>;',
        "tarmoto-localization/no-translated-fragments",
      ),
    ).not.toHaveLength(0);
  });

  it.each([
    'const view = <p>{items.map((item) => t("Updated") + item.time)}</p>;',
    'const view = <p>{items.flatMap((item) => { return `${t("Updated")} ${item.time}`; })}</p>;',
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
        'const view = <button aria-label={`${t("Updated")} ${formattedTime}`} />;',
        "tarmoto-localization/no-translated-fragments",
      ),
    ).not.toHaveLength(0);
  });

  it("rejects translated fragments nested in inline JSX", () => {
    expect(
      localizationMessages(
        'const view = <p><span><strong>{t("Updated")}</strong></span> {formattedTime}</p>;',
        "tarmoto-localization/no-translated-fragments",
      ),
    ).not.toHaveLength(0);
  });

  it("allows independently translated block children", () => {
    expect(
      localizationMessages(
        'const view = <p><b className="block">{t("Title")}</b>{t("Description")}</p>;',
        "tarmoto-localization/no-translated-fragments",
      ),
    ).toHaveLength(0);
  });

  it("allows independent translated atoms separated by a middle dot", () => {
    expect(
      localizationMessages(
        'const view = <span>{t("Distance")} · {formattedDistance}</span>;',
        "tarmoto-localization/no-translated-fragments",
      ),
    ).toHaveLength(0);
  });

  it("rejects translated fragments within separator-delimited atoms", () => {
    expect(
      localizationMessages(
        'const view = <p>{t("Updated")} {time} · {t("by")} {author}</p>;',
        "tarmoto-localization/no-translated-fragments",
      ),
    ).not.toHaveLength(0);
  });

  it("rejects visible numeric JSX text", () => {
    expect(
      localizationMessages(
        "const view = <span>01</span>;",
        "tarmoto-localization/no-visible-numeric-jsx-text",
      ),
    ).not.toHaveLength(0);
  });

  it("rejects visible numeric JSX expression literals", () => {
    expect(
      localizationMessages(
        "const view = <span>{2026}</span>;",
        "tarmoto-localization/no-visible-numeric-jsx-text",
      ),
    ).not.toHaveLength(0);
  });

  it.each([
    "const view = <Stat value={`${segment.curvinessScore}`} />;",
    "const view = <HeroStat value={rank == null ? '—' : `#${rank}`} />;",
    "const view = <Button>{count > 0 ? ` ${count}` : ''}</Button>;",
    "const view = <MetricTile delta={missingCount} />;",
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
        "const view = <Stat value={format.integer(segment.curvinessScore)} />;",
        "tarmoto-localization/no-visible-numeric-jsx-text",
      ),
    ).toHaveLength(0);
  });

  it.each([
    'const view = <span>{"2026"}</span>;',
    "const view = <span>{compact ? 1 : 2026}</span>;",
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
        "const view = <span>{format.integer(2026)}</span>;",
        "tarmoto-localization/no-visible-numeric-jsx-text",
      ),
    ).toHaveLength(0);
  });

  it("rejects numeric literals hidden in translator keys", () => {
    expect(
      localizationMessages(
        'const view = <input placeholder={t("2024")} />;',
        "tarmoto-localization/no-visible-numeric-jsx-text",
      ),
    ).not.toHaveLength(0);
  });

  it("allows numeric ICU values in translator calls", () => {
    expect(
      localizationMessages(
        'const view = <span>{t("{year}", { year: 2024 })}</span>;',
        "tarmoto-localization/no-visible-numeric-jsx-text",
      ),
    ).toHaveLength(0);
  });

  it("rejects numeric literals passed to non-formatter calls", () => {
    expect(
      localizationMessages(
        "const view = <span>{String(2026)}</span>;",
        "tarmoto-localization/no-visible-numeric-jsx-text",
      ),
    ).not.toHaveLength(0);
  });

  it.each([
    "const view = <span>{formatRaw(2026)}</span>;",
    "const view = <span>{format.raw(2026)}</span>;",
    "const view = <span>{unknown.format(2026)}</span>;",
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
        "const view = <span>{formatCount(2026, locale)}</span>;",
        "tarmoto-localization/no-visible-numeric-jsx-text",
      ),
    ).toHaveLength(0);
  });

  it("rejects numeric literals in non-formatter call receivers", () => {
    expect(
      localizationMessages(
        "const view = <span>{(2026).toString()}</span>;",
        "tarmoto-localization/no-visible-numeric-jsx-text",
      ),
    ).not.toHaveLength(0);
  });

  it("rejects numeric literals preserved by rendered collection calls", () => {
    expect(
      localizationMessages(
        "const view = <span>{[2026].filter(Boolean)}</span>;",
        "tarmoto-localization/no-visible-numeric-jsx-text",
      ),
    ).not.toHaveLength(0);
  });

  it.each([
    "const view = <span>{items.map((_, index) => index + 1)}</span>;",
    "const view = <span>{items.flatMap((_, index) => { return index + 1; })}</span>;",
  ])("rejects numeric values returned by rendered callbacks", (source) => {
    expect(
      localizationMessages(
        source,
        "tarmoto-localization/no-visible-numeric-jsx-text",
      ),
    ).not.toHaveLength(0);
  });

  it.each([
    "const view = <button aria-label={String(2026)} />;",
    'const view = <button aria-label={"2026"} />;',
    'const view = <button aria-label="2026" />;',
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
        "const view = <span>{[1, 2, 3].map(renderItem)}</span>;",
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
          `function applySearch(value, locale) { const needle = ${normalization}; return needle; }`,
          "tarmoto-localization/no-locale-insensitive-search",
        ),
      ).not.toHaveLength(0);
    },
  );
});
