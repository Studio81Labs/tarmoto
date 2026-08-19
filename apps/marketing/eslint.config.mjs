// Flat config for the marketing (Next.js) app. Mirrors apps/companion's
// setup: load Next's lint plugin directly rather than via
// `eslint-config-next` (which ships through `@rushstack/eslint-patch`
// and crashes on ESLint 10). Owns the rule list but unblocks ESLint 10
// and replaces the `next lint` command that Next.js 16 removed.

import js from "@eslint/js";
import next from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// Globals that exist in the Cloudflare Workers runtime *and* in
// Node ≥ 18 — the worker .mjs files (and their tests) live at the
// app root and run in both environments depending on context.
const workerRuntimeGlobals = {
  URL: "readonly",
  URLSearchParams: "readonly",
  Request: "readonly",
  Response: "readonly",
  Headers: "readonly",
  fetch: "readonly",
  crypto: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  console: "readonly",
  CustomEvent: "readonly",
  Event: "readonly",
  EventListener: "readonly",
  KVNamespace: "readonly",
  process: "readonly",
};

export default [
  {
    ignores: [".next/**", "out/**", "node_modules/**", "next-env.d.ts"],
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
  {
    // worker.mjs + worker.test.mjs + waitlist-confirmation-email.mjs +
    // social-metadata.test.mjs all run in either the Cloudflare Workers
    // runtime or Node — they don't get TypeScript's lib types so ESLint
    // needs the global names declared explicitly.
    files: ["*.mjs"],
    languageOptions: {
      globals: workerRuntimeGlobals,
    },
  },
];
