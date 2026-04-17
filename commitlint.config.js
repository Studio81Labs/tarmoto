// Enforces conventional commits on every commit (via husky commit-msg).
// Matches the types and scopes enforced by .github/workflows/lint-pr.yml
// and documented in CONTRIBUTING.md / AGENTS.md.
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'chore', 'refactor', 'docs', 'test', 'style', 'perf', 'ci', 'build', 'revert'],
    ],
    'scope-enum': [
      2,
      'always',
      ['backend', 'mobile', 'companion', 'poc', 'shared', 'openapi', 'ci', 'infra', 'docs', 'deps'],
    ],
    'scope-empty': [0, 'never'],
    'subject-case': [2, 'always', 'lower-case'],
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],
  },
};
