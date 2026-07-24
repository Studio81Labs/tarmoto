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

describe("companion indirect display-copy lint guard", () => {
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
});
