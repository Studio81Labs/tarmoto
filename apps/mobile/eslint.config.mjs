// Minimal ESLint 9 flat config for the React Native app.
//
// We deliberately don't extend @react-native/eslint-config here because
// that brings in eslint-plugin-ft-flow, which still calls the removed
// `context.getAllComments()` API and crashes on ESLint 9. This project
// uses TypeScript, not Flow, so those rules have nothing useful to check.
//
// If/when @react-native/eslint-config publishes a version that drops
// the ft-flow dependency (or ft-flow itself updates), switch back to
// extending it via FlatCompat.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "android/**",
      "ios/**",
      "node_modules/**",
      "babel.config.js",
      "jest.config.js",
      "metro.config.js",
      "lib/api/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        __DEV__: "readonly",
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
