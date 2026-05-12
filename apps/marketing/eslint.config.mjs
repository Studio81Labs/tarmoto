// Flat config for the marketing (Next.js) app. Mirrors apps/companion's
// setup: load Next's lint plugin directly rather than via
// `eslint-config-next` (which ships through `@rushstack/eslint-patch`
// and crashes on ESLint 10). Owns the rule list but unblocks ESLint 10
// and replaces the `next lint` command that Next.js 16 removed.

import js from "@eslint/js";
import next from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      ".next/**",
      "out/**",
      "node_modules/**",
      "next-env.d.ts",
      // The Cloudflare Worker that ships alongside the site is a
      // separate package (`@tarmoto/worker`) with its own type roots;
      // it has its own typecheck and tests and doesn't need to share
      // this app's ESLint rule list.
      "worker/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs}"],
    plugins: {
      "@next/next": next,
      "react-hooks": reactHooks,
    },
    rules: {
      ...next.configs.recommended.rules,
      ...next.configs["core-web-vitals"].rules,
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];
