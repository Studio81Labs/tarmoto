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
            "CallExpression[callee.name=/^set[A-Z][A-Za-z]*(Error|Message|Banner|Notice|Toast)[A-Za-z]*$/] > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap rider-facing error state with translate()/tDynamic before passing it to the setter.",
        },
        {
          selector:
            "CallExpression[callee.name=/^set[A-Z][A-Za-z]*(Error|Message|Banner|Notice|Toast)[A-Za-z]*$/] > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
          message:
            "Compose rider-facing error state through one ICU catalog message.",
        },
        {
          selector:
            "CallExpression[callee.name=/^set[A-Z][A-Za-z]*(Error|Message|Banner|Notice|Toast)[A-Za-z]*$/] > ConditionalExpression > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap every rider-facing error-state branch with translate()/tDynamic.",
        },
        {
          selector:
            "CallExpression[callee.name=/^set[A-Z][A-Za-z]*(Error|Message|Banner|Notice|Toast)[A-Za-z]*$/] MemberExpression[computed=false][property.name='message']",
          message:
            "Do not expose arbitrary Error.message text. Use getUserFacingErrorMessage(error, translate(…)) so only cataloged API errors pass through.",
        },
        {
          selector:
            "CallExpression[callee.name=/^set[A-Z]/] Property[key.name=/^(error|message|description)$/] > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap rider-facing copy nested in state objects with translate()/tDynamic before passing it to the setter.",
        },
        {
          selector:
            "CallExpression[callee.name=/^set[A-Z]/] Property[key.name=/^(error|message|description)$/] > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
          message:
            "Compose rider-facing copy nested in state objects through one ICU catalog message.",
        },
        {
          selector:
            "Property[key.name='message'] > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Route rider-facing message properties through translate()/tDynamic. Document a scoped exception for non-display protocol data.",
        },
        {
          selector:
            "Property[key.name='message'] > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
          message:
            "Compose rider-facing message properties through one ICU catalog message.",
        },
        {
          selector:
            "Property[key.name='message'] > ConditionalExpression > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap every rider-facing message-property branch with translate()/tDynamic.",
        },
        {
          selector:
            "CallExpression[callee.property.name='onError'] > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap rider-facing onError() copy with translate()/tDynamic.",
        },
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
            "JSXAttribute[name.name=/^(body|headline|text)$/] > Literal[value=/[A-Za-z]{2,}/]",
          message: "Wrap rider-facing component props with translate().",
        },
        {
          selector:
            "JSXAttribute[name.name=/^(body|headline|text)$/] > JSXExpressionContainer > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap rider-facing component prop literals with translate().",
        },
        {
          selector:
            "JSXAttribute[name.name=/^(body|headline|text)$/] > JSXExpressionContainer > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
          message:
            "Replace rider-facing component prop templates with one translate() ICU message.",
        },
        {
          selector:
            "JSXAttribute[name.name=/^(body|headline|text)$/] ConditionalExpression > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap conditional rider-facing component props with translate().",
        },
        {
          selector:
            "JSXAttribute[name.name=/^(body|headline|text)$/] ConditionalExpression > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
          message:
            "Replace conditional rider-facing component prop templates with one translate() ICU message.",
        },
        {
          selector:
            "JSXAttribute[name.name=/^(body|headline|text)$/] > JSXExpressionContainer > BinaryExpression :matches(Literal[value=/[A-Za-z]{2,}/], TemplateElement[value.raw=/[A-Za-z]{2,}/])",
          message:
            "Replace concatenated rider-facing component props with one translate() ICU message.",
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
            "CallExpression[callee.name=/^set.*(Banner|Error|Message|Notice|Validation|Warning)$/] > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap rider-facing validation/status messages with translate().",
        },
        {
          selector:
            "CallExpression[callee.name=/^set.*(Banner|Error|Message|Notice|Validation|Warning)$/] > ConditionalExpression > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap rider-facing conditional validation/status messages with translate().",
        },
        {
          selector:
            "CallExpression[callee.name=/^set.*(Error|Message|Notice|Validation|Warning)$/] LogicalExpression > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap rider-facing logical fallback messages with translate().",
        },
        {
          selector:
            "CallExpression[callee.name=/^set.*(Banner|Error|Message|Notice|Validation|Warning)$/] MemberExpression[computed=false][property.name='message']",
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
            "VariableDeclarator[id.name=/^(description|emptyText|headline|helpText|label|message|subtitle|title)$/] ConditionalExpression > Literal[value=/[A-Za-z]{2,}/]",
          message:
            "Wrap conditional rider-facing copy variables with translate().",
        },
        {
          selector:
            "VariableDeclarator[id.name=/^(description|emptyText|headline|helpText|label|message|subtitle|title)$/] ConditionalExpression > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
          message:
            "Replace conditional rider-facing copy templates with one ICU catalog message.",
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
          selector:
            "Program:has(ImportDeclaration[source.value='@/i18n'] ImportSpecifier[imported.name=/^(t|translate|tDynamic)$/]) CallExpression[callee.object.name='React'][callee.property.name='memo'], Program:has(ImportDeclaration[source.value='@/i18n'] ImportSpecifier[imported.name=/^(t|translate|tDynamic)$/]) CallExpression[callee.name='memo']",
          message:
            "Memoized React render paths must use useTranslation() so locale context changes bypass the props memoization boundary.",
        },
        {
          selector:
            "Program:has(ImportDeclaration[source.value='@/format'] ImportSpecifier[imported.name='getFormatters']) CallExpression[callee.object.name='React'][callee.property.name='memo'], Program:has(ImportDeclaration[source.value='@/format'] ImportSpecifier[imported.name='getFormatters']) CallExpression[callee.name='memo']",
          message:
            "Memoized React render paths must use useFormat() so format-context changes bypass the props memoization boundary.",
        },
        {
          selector:
            "JSXElement > JSXExpressionContainer > Identifier[name=/(count|Count|total|Total|rank|Rank|year|Year|day|Day|page|Page|rating|Rating|score|Score|percent|Percent|index|Index)$/]",
          message:
            "Format directly rendered numeric values with the active regional formatter.",
        },
        {
          selector:
            "JSXElement > JSXExpressionContainer > MemberExpression[computed=false][property.name=/(count|Count|total|Total|rank|Rank|year|Year|day|Day|page|Page|rating|Rating|score|Score|percent|Percent|index|Index|length)$/]",
          message:
            "Format directly rendered numeric properties with the active regional formatter.",
        },
        {
          selector:
            "CallExpression[callee.property.name=/^(toLocaleUpperCase|toLocaleLowerCase)$/][arguments.length=0]",
          message:
            "Pass the active UI or format locale when changing rider-facing display case.",
        },
        {
          selector:
            "JSXElement > JSXExpressionContainer CallExpression[callee.property.name=/^(toUpperCase|toLowerCase)$/]",
          message:
            "Use locale-aware casing with the active UI or format locale for rider-facing display text.",
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
