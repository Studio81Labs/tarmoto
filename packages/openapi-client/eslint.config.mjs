// @ts-check
// Standalone rather than extending a shared root config, matching apps/backend
// and apps/admin -- this repo composes per-app configs.
//
// `src/generated/` is emitted verbatim by openapi-typescript (pinned exact)
// and committed for the openapi-check freshness gate. Linting it reports
// thousands of errors against code nobody edits, which is the kind of noise
// that gets a whole lint run muted; tabletap hit exactly that (4,736 errors)
// before ignoring it. What is left is the hand-written client surface
// (client.ts, index.ts, browser-safe.ts, react-query.ts) and its tests, which
// were reachable by no lint at all until now.
import eslint from "@eslint/js";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["eslint.config.mjs", "src/generated/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      // The client runs in the browser (companion/admin) and under Node
      // (codegen and tests), so both global sets are in scope.
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      "prettier/prettier": ["error", { endOfLine: "auto" }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
);
