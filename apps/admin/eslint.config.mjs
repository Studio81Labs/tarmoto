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
    },
  },
];
