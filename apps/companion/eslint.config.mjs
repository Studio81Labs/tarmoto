// Flat config for the companion (Next.js) app. We intentionally don't
// use `eslint-config-next` because it ships its rules through
// `@rushstack/eslint-patch`, which crashes on ESLint 10 ("Failed to
// patch ESLint because the calling module was not recognized").
// Instead, load Next's lint plugin directly and apply its recommended
// + core-web-vitals rule sets alongside typescript-eslint and
// react-hooks. This owns the rule list but unblocks ESLint 10.

import js from "@eslint/js";
import next from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      ".next/**",
      // Build output from `opennextjs-cloudflare build` — Worker bundle
      // and assets, not source.
      ".open-next/**",
      "node_modules/**",
      "next-env.d.ts",
      "cloudflare-env.d.ts",
      // Playwright tests live under e2e/ and use Playwright's fixture
      // function `use`, which `react-hooks/rules-of-hooks` flags as a
      // misused React hook. The suite has its own runner and tsconfig;
      // ESLint isn't useful here.
      "e2e/**",
      "playwright-report/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,jsx}"],
    plugins: {
      "@next/next": next,
      "react-hooks": reactHooks,
    },
    rules: {
      ...next.configs.recommended.rules,
      ...next.configs["core-web-vitals"].rules,
      // Only keep the two classic react-hooks rules. react-hooks@7's
      // `recommended` ships newer lints (set-state-in-effect, refs,
      // etc.) that flood the existing codebase; keep eslint-10 scope
      // tight and file those as follow-ups.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Guard the #861 migration: the companion talks to the backend only
      // through the generated OpenAPI client. Flag any raw `fetch()` whose URL
      // is built from an API base/host so a new raw helper can't creep back in.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.name='fetch'] > TemplateLiteral > Identifier[name=/^API_(BASE|HOST)/]",
          message:
            "Don't fetch the backend directly. Use the generated client — `api` / `apiServer` from `@/lib/api` (see #861).",
        },
      ],
    },
  },
];
