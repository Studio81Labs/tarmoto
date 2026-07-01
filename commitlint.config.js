// Enforces conventional commits on every local commit (via husky commit-msg).
// Shares the same scope vocabulary as .github/workflows/lint-pr.yml and the
// contributor docs, while also requiring a scope locally.
module.exports = {
  extends: ["@commitlint/config-conventional"],
  plugins: [
    {
      rules: {
        // Mirrors lint-pr.yml's subjectPattern: ^(?![A-Z]).+$
        // — the first character of the subject must not be uppercase.
        // Acronyms later in the subject (API, UI, GPS, JSON, ...) are fine.
        "subject-first-char-lowercase": ({ subject }) => {
          if (!subject) return [true];
          const first = subject[0];
          return [
            first === first.toLowerCase(),
            "subject must start with a lowercase character",
          ];
        },
      },
    },
  ],
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
        "admin",
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
    // Disable the strict all-lowercase rule (it rejects legitimate
    // acronyms like API, UI, GPS, JSON) and use our custom rule above
    // to mirror lint-pr.yml's leading-lowercase check exactly.
    "subject-case": [0],
    "subject-first-char-lowercase": [2, "always"],
    "subject-empty": [2, "never"],
    "subject-full-stop": [2, "never", "."],
  },
};
