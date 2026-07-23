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
          selector:
            "FunctionDeclaration[id.name=/(Label|Message|Copy|Text|Title|Description|Unit|Short)$/]:not(:has(TSTypeReference[typeName.name='EnglishMessageKey'])) ReturnStatement > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Display helpers must return translate()-cataloged copy, not raw prose. Return an EnglishMessageKey for translation at the caller, or document a non-display token.",
        },
        {
          selector:
            "FunctionDeclaration[id.name=/(Label|Message|Copy|Text|Title|Description|Unit|Short)$/]:not(:has(TSTypeReference[typeName.name='EnglishMessageKey'])) ReturnStatement > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
          message:
            "Display helpers must compose rider-facing templates through one ICU catalog message.",
        },
        {
          selector:
            "VariableDeclarator[id.name=/(Label|Message|Copy|Text|Title|Description|Unit|Short)$/] > :matches(ArrowFunctionExpression, FunctionExpression):not(:has(TSTypeReference[typeName.name='EnglishMessageKey'])) > Literal[value=/[A-Za-z]{2,}/], VariableDeclarator[id.name=/(Label|Message|Copy|Text|Title|Description|Unit|Short)$/] > :matches(ArrowFunctionExpression, FunctionExpression):not(:has(TSTypeReference[typeName.name='EnglishMessageKey'])) ReturnStatement > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Display helpers must return translate()-cataloged copy, not raw prose. Return an EnglishMessageKey for translation at the caller, or document a non-display token.",
        },
        {
          selector:
            "VariableDeclarator[id.name=/(Label|Message|Copy|Text|Title|Description|Unit|Short)$/] > :matches(ArrowFunctionExpression, FunctionExpression):not(:has(TSTypeReference[typeName.name='EnglishMessageKey'])) > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/], VariableDeclarator[id.name=/(Label|Message|Copy|Text|Title|Description|Unit|Short)$/] > :matches(ArrowFunctionExpression, FunctionExpression):not(:has(TSTypeReference[typeName.name='EnglishMessageKey'])) ReturnStatement > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
          message:
            "Display helpers must compose rider-facing templates through one ICU catalog message.",
        },
        {
          selector: "CallExpression[callee.name='fetch']",
          message:
            "Don't call fetch() directly. Use the generated client — `client` from `@/services/typedClient` (via `@/services/api`). (Raw fetch is confined to services/typedClient.ts, the auth-refresh middleware.)",
        },
        // Mobile i18n guard (#1049): typed translate() catches unregistered
        // keys only after copy reaches the translator. These selectors close
        // the common React Native bypasses: raw JSX children, rider-facing
        // props, alerts, spoken prompts, and validation state.
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
            "JSXElement > JSXExpressionContainer > MemberExpression[computed=false][property.name=/(^|_)(status|surface|severity|tier|role|type|reason|metric)$/]",
          message:
            "Translate stable enum/wire values through a cataloged label map before rendering them.",
        },
        {
          selector:
            "JSXElement > JSXExpressionContainer > LogicalExpression > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap rider-facing logical fallback copy with translate() instead of rendering a raw string.",
        },
        {
          selector:
            "JSXElement > JSXExpressionContainer > MemberExpression[computed=true][object.name=/[A-Z0-9_]*(LABEL|TITLE|DESCRIPTION|MESSAGE|COPY|TEXT)[A-Z0-9_]*/]",
          message:
            "Translate catalog-shaped label maps at render time; type their values as EnglishMessageKey.",
        },
        {
          selector:
            "JSXElement > JSXExpressionContainer CallExpression[callee.property.name='toFixed']",
          message:
            "Format rider-facing numbers with getFormatters() instead of toFixed().",
        },
        {
          selector:
            "JSXAttribute[name.name=/^(accessibilityHint|accessibilityLabel|actionLabel|aria-label|ariaLabel|cancelText|confirmText|description|emptyText|headerTitle|helpText|label|message|placeholder|subtitle|tabBarLabel|title)$/] > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap rider-facing prop text with translate(), or document a deliberate non-translatable value.",
        },
        {
          selector:
            "JSXAttribute[name.name=/^(accessibilityHint|accessibilityLabel|actionLabel|aria-label|ariaLabel|cancelText|confirmText|description|emptyText|headerTitle|helpText|label|message|placeholder|subtitle|tabBarLabel|title)$/] > JSXExpressionContainer > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap rider-facing prop text with translate(), or document a deliberate non-translatable value.",
        },
        {
          selector:
            "JSXAttribute[name.name=/^(accessibilityHint|accessibilityLabel|actionLabel|aria-label|ariaLabel|cancelText|confirmText|description|emptyText|headerTitle|helpText|label|message|placeholder|subtitle|tabBarLabel|title)$/] > JSXExpressionContainer > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
          message:
            "Replace rider-facing prop templates with one translate() ICU message and named values.",
        },
        {
          selector:
            "JSXAttribute[name.name=/^(accessibilityHint|accessibilityLabel|actionLabel|aria-label|ariaLabel|cancelText|confirmText|description|emptyText|headerTitle|helpText|label|message|placeholder|subtitle|tabBarLabel|title)$/] ConditionalExpression > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap every rider-facing conditional prop branch with translate().",
        },
        {
          selector:
            "JSXAttribute[name.name=/^(accessibilityHint|accessibilityLabel|actionLabel|aria-label|ariaLabel|cancelText|confirmText|description|emptyText|headerTitle|helpText|label|message|placeholder|subtitle|tabBarLabel|title)$/] ConditionalExpression > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
          message:
            "Replace conditional rider-facing templates with translate() ICU messages.",
        },
        {
          selector:
            "JSXAttribute[name.name=/^(accessibilityHint|accessibilityLabel|actionLabel|aria-label|ariaLabel|cancelText|confirmText|description|emptyText|headerTitle|helpText|label|message|placeholder|subtitle|tabBarLabel|title)$/] > JSXExpressionContainer > BinaryExpression > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Replace concatenated rider-facing prop copy with one translate() ICU message and named values.",
        },
        {
          selector:
            "JSXAttribute[name.name=/^(accessibilityHint|accessibilityLabel|actionLabel|aria-label|ariaLabel|cancelText|confirmText|description|emptyText|headerTitle|helpText|label|message|placeholder|subtitle|tabBarLabel|title)$/] > JSXExpressionContainer > BinaryExpression > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
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
            "CallExpression[callee.object.name='Alert'][callee.property.name='alert'] > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
          message:
            "Replace Alert.alert title/body templates with one translate() ICU message and named values.",
        },
        {
          selector:
            "CallExpression[callee.object.name='ttsService'][callee.property.name='speak'] > Literal[value=/[A-Za-z]{2,}/]",
          message: "Wrap rider-facing spoken prompts with translate().",
        },
        {
          selector:
            "CallExpression[callee.object.name='ttsService'][callee.property.name='speak'] > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
          message:
            "Replace rider-facing spoken templates with one translate() ICU message and named values.",
        },
        {
          selector:
            "CallExpression[callee.name=/^set.*(Error|Message|Notice|Validation|Warning)$/] > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap rider-facing validation/status messages with translate().",
        },
        {
          selector:
            "CallExpression[callee.name=/^set.*(Error|Message|Notice|Validation|Warning)$/] > ConditionalExpression > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap rider-facing conditional validation/status messages with translate().",
        },
        {
          selector:
            "CallExpression[callee.name=/^set.*(Error|Message|Notice|Validation|Warning)$/] MemberExpression[computed=false][property.name='message']",
          message:
            "Do not expose arbitrary Error.message text. Use getUserFacingErrorMessage(error, translate(…)) so only cataloged API errors pass through.",
        },
        {
          selector:
            "CallExpression[callee.object.name='Alert'][callee.property.name='alert'] MemberExpression[computed=false][property.name='message']",
          message:
            "Do not expose arbitrary Error.message text in alerts. Use getUserFacingErrorMessage with translated fallback copy.",
        },
        {
          selector:
            "Property[key.name=/^(error|message|description)$/] MemberExpression[computed=false][property.name='message']",
          message:
            "Do not store arbitrary Error.message text in rider-facing state. Use getUserFacingErrorMessage with translated fallback copy.",
        },
        {
          selector:
            "VariableDeclarator[id.name=/^(error|errorMessage|message|notice|validation|warning)$/] > ConditionalExpression > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap rider-facing conditional status-copy variables with translate() before passing them to state setters or alerts.",
        },
        {
          selector:
            "VariableDeclarator[id.name=/^(error|errorMessage|message|notice|validation|warning)$/] > ConditionalExpression > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
          message:
            "Replace rider-facing conditional status-copy templates with one translate() ICU message.",
        },
        {
          selector:
            "VariableDeclarator[id.name=/(^title$|Title$|Label$|displayName$|fallbackName$|rideName$)/] > Literal[value=/[A-Za-z]{2,}/], VariableDeclarator[id.name=/(^title$|Title$|Label$|displayName$|fallbackName$|rideName$)/] > :matches(ConditionalExpression, LogicalExpression) > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Translate rider-facing display variables before rendering them.",
        },
        {
          selector:
            "VariableDeclarator[id.name=/(^title$|Title$|Label$|displayName$|fallbackName$|rideName$)/] > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/], VariableDeclarator[id.name=/(^title$|Title$|Label$|displayName$|fallbackName$|rideName$)/] > :matches(ConditionalExpression, LogicalExpression) > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
          message:
            "Compose rider-facing display-variable templates through one translate() ICU message.",
        },
        {
          selector:
            "CallExpression[callee.name='markFailed'] > Literal:first-child[value=/[A-Za-z]{2,}/]",
          message: "Wrap rider-facing failure messages with translate().",
        },
        {
          selector:
            "CallExpression[callee.name='markFailed'] > ConditionalExpression:first-child > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap every rider-facing conditional failure message with translate().",
        },
        {
          selector: "CallExpression[callee.property.name='toLocaleString']",
          message:
            "Use getFormatters()/useFormat() instead of toLocaleString so mobile locale preferences are applied.",
        },
        {
          selector: "CallExpression[callee.property.name='toLocaleDateString']",
          message:
            "Use getFormatters()/useFormat() instead of toLocaleDateString.",
        },
        {
          selector: "CallExpression[callee.property.name='toLocaleTimeString']",
          message:
            "Use getFormatters()/useFormat() instead of toLocaleTimeString.",
        },
        {
          selector: "NewExpression[callee.object.name='Intl']",
          message: "Construct Intl display formatters only inside src/format.",
        },
        {
          selector:
            "CallExpression[callee.object.name='Intl'][callee.property.name='NumberFormat']",
          message: "Construct number formatters only inside src/format.",
        },
      ],
    },
  },
  {
    // The formatter implementation is the sole sanctioned Intl construction
    // site. It contains no rider-facing JSX or backend calls.
    files: ["src/format/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": "off",
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
