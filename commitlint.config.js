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
      ],
    ],
    "scope-empty": [2, "never"],
    "subject-case": [2, "always", "lower-case"],
    "subject-empty": [2, "never"],
    "subject-full-stop": [2, "never", "."],
  },
};
