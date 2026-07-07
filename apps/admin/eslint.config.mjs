// Flat ESLint config for the admin app (Vite + React + TypeScript).
// Modelled on apps/companion/eslint.config.mjs but without Next-specific plugins.

import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Cloudflare Worker + its node:test file run on the Web platform / Workers
    // runtime, not the browser DOM — declare those globals so no-undef passes.
    files: ["worker.mjs", "adminProxyShared.mjs", "worker.test.mjs"],
    languageOptions: {
      globals: {
        fetch: "readonly",
        Request: "readonly",
        Response: "readonly",
        Headers: "readonly",
        URL: "readonly",
        console: "readonly",
      },
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      // Only the two classic react-hooks rules — keeps scope tight.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Regression guard (mirrors apps/companion): the admin console talks to
      // the backend only through the generated `@tarmoto/openapi-client`
      // (`$api` / `apiClient` from `@/data/apiClient`). Ban bare `fetch()` so a
      // new raw backend call can't creep back in. The admin API is served at
      // relative `/admin/*` paths (createClient `baseUrl: ""`), so a URL-pattern
      // selector wouldn't catch a `fetch("/admin/...")` regression — ban the
      // call outright instead. The one sanctioned raw fetch (the 401 →
      // refresh → replay middleware) lives in `data/apiClient.ts`, exempted
      // below.
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='fetch']",
          message:
            "Don't call fetch() directly. Use the generated client — `$api` / `apiClient` from `@/data/apiClient`. (Raw fetch is confined to data/apiClient.ts, the auth-refresh middleware.)",
        },
      ],
    },
  },
  {
    // `data/apiClient.ts` is the one sanctioned home for raw fetch: it wraps
    // openapi-fetch with the 401 → refresh → replay middleware, which must use
    // raw fetch to bypass the typed client (refreshing on the refresh call
    // itself would recurse).
    files: ["src/data/apiClient.ts"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
];
