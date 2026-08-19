// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'eslint.config.mjs',
      // Generated demo-ride data module (emitted verbatim by
      // generate-real-demo-rides.mjs) + its one-off generator script.
      'src/scripts/demo-seed/real-demo-rides.data.ts',
      'src/scripts/demo-seed/generate-real-demo-rides.mjs',
      // One-off Natural Earth boundary generator (#944) — run once, output
      // committed; see assets/README.md.
      'src/scripts/derive-region-boundaries.mjs',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
  {
    // TypeScript 6's checker lets the type-aware unbound-method rule see the
    // mock idiom `expect(service.method).toHaveBeenCalled…` for what it is —
    // a method reference passed without a receiver — and flags all ~437 of
    // them. In jest tests that reference is the assertion idiom, not a bug;
    // typescript-eslint's own docs say to turn the rule off in test files
    // (eslint-plugin-jest ships the jest-aware variant if we ever want it
    // back). Production src/ keeps the rule.
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
