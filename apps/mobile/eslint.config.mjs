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
      "jest.setup.js",
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
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
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
      "@typescript-eslint/no-deprecated": "error",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // React Native legitimately uses require() for native modules and
      // bundled image assets (`require('./logo.png')`). ES imports don't
      // work for those at runtime.
      "@typescript-eslint/no-require-imports": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Regression guard (mirrors apps/companion): the app talks to the backend
      // only through the generated `@tarmoto/openapi-client` — the typed
      // `client` from `@/services/typedClient`, consumed via `@/services/api`.
      // Ban bare `fetch()` so a new raw backend call can't creep back in. The
      // sanctioned raw fetches (the 401 → refresh → replay middleware and the
      // `rawFetch` logout escape hatch) live in `services/typedClient.ts`,
      // exempted below.
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='fetch']",
          message:
            "Don't call fetch() directly. Use the generated client — `client` from `@/services/typedClient` (via `@/services/api`). (Raw fetch is confined to services/typedClient.ts, the auth-refresh middleware.)",
        },
        // Mobile i18n guard (#1049): typed translate() catches unregistered
        // keys only after copy reaches the translator. These selectors close
        // the common React Native bypasses: raw JSX children, rider-facing
        // props, alerts, and validation state.
        {
          selector: "JSXText[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap rider-facing JSX text with translate(). If it is deliberately not translatable, add a scoped disable comment explaining why.",
        },
        {
          selector:
            "JSXElement > JSXExpressionContainer > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap rider-facing string children with translate(). If deliberately not translatable, document the exception.",
        },
        {
          selector:
            "JSXElement > JSXExpressionContainer > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
          message:
            "Replace rider-facing JSX templates with one translate() ICU message and named values.",
        },
        {
          selector:
            "JSXElement > JSXExpressionContainer > ConditionalExpression > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap every rider-facing conditional JSX branch with translate().",
        },
        {
          selector:
            "JSXElement > JSXExpressionContainer > ConditionalExpression > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
          message:
            "Replace conditional rider-facing JSX templates with translate() ICU messages.",
        },
        {
          selector:
            "JSXAttribute[name.name=/^(accessibilityHint|accessibilityLabel|actionLabel|aria-label|ariaLabel|cancelText|confirmText|description|emptyText|headerTitle|label|message|placeholder|subtitle|tabBarLabel|title)$/] > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap rider-facing prop text with translate(), or document a deliberate non-translatable value.",
        },
        {
          selector:
            "JSXAttribute[name.name=/^(accessibilityHint|accessibilityLabel|actionLabel|aria-label|ariaLabel|cancelText|confirmText|description|emptyText|headerTitle|label|message|placeholder|subtitle|tabBarLabel|title)$/] > JSXExpressionContainer > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap rider-facing prop text with translate(), or document a deliberate non-translatable value.",
        },
        {
          selector:
            "JSXAttribute[name.name=/^(accessibilityHint|accessibilityLabel|actionLabel|aria-label|ariaLabel|cancelText|confirmText|description|emptyText|headerTitle|label|message|placeholder|subtitle|tabBarLabel|title)$/] > JSXExpressionContainer > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
          message:
            "Replace rider-facing prop templates with one translate() ICU message and named values.",
        },
        {
          selector:
            "JSXAttribute[name.name=/^(accessibilityHint|accessibilityLabel|actionLabel|aria-label|ariaLabel|cancelText|confirmText|description|emptyText|headerTitle|label|message|placeholder|subtitle|tabBarLabel|title)$/] ConditionalExpression > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap every rider-facing conditional prop branch with translate().",
        },
        {
          selector:
            "JSXAttribute[name.name=/^(accessibilityHint|accessibilityLabel|actionLabel|aria-label|ariaLabel|cancelText|confirmText|description|emptyText|headerTitle|label|message|placeholder|subtitle|tabBarLabel|title)$/] ConditionalExpression > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
          message:
            "Replace conditional rider-facing templates with translate() ICU messages.",
        },
        {
          selector:
            "JSXAttribute[name.name=/^(accessibilityHint|accessibilityLabel|actionLabel|aria-label|ariaLabel|cancelText|confirmText|description|emptyText|headerTitle|label|message|placeholder|subtitle|tabBarLabel|title)$/] > JSXExpressionContainer > BinaryExpression > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Replace concatenated rider-facing prop copy with one translate() ICU message and named values.",
        },
        {
          selector:
            "JSXAttribute[name.name=/^(accessibilityHint|accessibilityLabel|actionLabel|aria-label|ariaLabel|cancelText|confirmText|description|emptyText|headerTitle|label|message|placeholder|subtitle|tabBarLabel|title)$/] > JSXExpressionContainer > BinaryExpression > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
          message:
            "Replace concatenated rider-facing prop copy with one translate() ICU message and named values.",
        },
        {
          selector:
            "CallExpression[callee.object.name='Alert'][callee.property.name='alert'] > Literal[value=/[A-Za-z]{2,}/]",
          message: "Wrap Alert.alert title/body literals with translate().",
        },
        {
          selector:
            "CallExpression[callee.name=/^set.*(Error|Message|Notice|Warning)$/] > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap rider-facing validation/status messages with translate().",
        },
        {
          selector:
            "CallExpression[callee.name=/^set.*(Error|Message|Notice|Warning)$/] > ConditionalExpression > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap rider-facing conditional validation/status messages with translate().",
        },
      ],
    },
  },
  {
    // Test fixtures assert rendered English and deliberately contain raw
    // strings. Keep the production i18n guard out of tests while retaining
    // the existing raw-fetch boundary.
    files: [
      "**/__tests__/**/*.{ts,tsx}",
      "**/*.test.{ts,tsx}",
      "**/*.spec.{ts,tsx}",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='fetch']",
          message:
            "Don't call fetch() directly. Use the generated client — `client` from `@/services/typedClient` (via `@/services/api`). (Raw fetch is confined to services/typedClient.ts, the auth-refresh middleware.)",
        },
      ],
    },
  },
  {
    // `services/typedClient.ts` is the one sanctioned home for raw fetch: it
    // wraps `createTarmotoClient` with the 401 → refresh → replay middleware
    // (which must use raw fetch to bypass the typed client — refreshing on the
    // refresh call itself would recurse) plus the `rawFetch` logout escape
    // hatch.
    files: ["src/services/typedClient.ts"],
    rules: {
      "no-restricted-syntax": "off",
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
