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
      "react-native.config.js",
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
      // React Native legitimately uses require() for native modules and
      // bundled image assets (`require('./logo.png')`). ES imports don't
      // work for those at runtime.
      "@typescript-eslint/no-require-imports": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // Silently drop any `/* eslint-disable import/... */` directives
    // left over from the old RN eslint-config. We don't ship
    // eslint-plugin-import on this config, so references to its rules
    // would otherwise report as "Definition for rule X was not found".
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
  },
];
