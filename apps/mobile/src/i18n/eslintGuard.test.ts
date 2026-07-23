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

  it("rejects uncataloged banner state", () => {
    expect(
      guardMessages('setStatusBanner(active ? "Queued for upload" : null);'),
    ).not.toHaveLength(0);
  });
});
