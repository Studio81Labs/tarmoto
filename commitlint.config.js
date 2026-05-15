// Enforces conventional commits on every local commit (via husky commit-msg).
// Shares the same scope vocabulary as .github/workflows/lint-pr.yml and the
// contributor docs, while also requiring a scope locally.
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "chore",
        "refactor",
        "docs",
        "test",
        "style",
        "perf",
        "ci",
        "build",
        "revert",
      ],
    ],
    "scope-enum": [
      2,
      "always",
      [
        "backend",
        "mobile",
        "companion",
        "poc-sensor",
        "shared",
        "openapi",
        "ci",
        "infra",
        "docs",
        "deps",
        "cross",
        "marketing",
      ],
    ],
    "scope-empty": [2, "never"],
    // subject-case left to the PR-title check (lint-pr.yml subjectPattern),
    // which requires only the first character to be lowercase. Strict
    // all-lowercase rejects legitimate acronyms (API, UI, GPS, JSON, ...).
    "subject-case": [0],
    "subject-empty": [2, "never"],
    "subject-full-stop": [2, "never", "."],
  },
};
