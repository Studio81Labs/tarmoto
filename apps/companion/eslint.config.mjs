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
import { localizationPlugin } from "../../scripts/eslint/localization-rules.mjs";

// Shared by both `no-restricted-syntax` blocks below (the broad
// **/*.{ts,tsx,js,jsx} block and the src-scoped block). Flat config resolves
// two matching configs that set the *same* rule key by letting the later one
// win outright — it does not concatenate `no-restricted-syntax` option
// arrays — so the src-scoped block must re-list these selectors (plus its own
// locale-formatting additions) rather than relying on the broad block. A
// single shared array keeps the two copies from drifting out of sync.
const restrictedSyntaxSelectors = [
  // Companion helpers can execute during concurrent server renders, where a
  // module-default English translator is not request-safe. Make translation
  // dependencies explicit so omitted call-site context is a compile/lint
  // failure instead of a silent English fallback.
  {
    selector:
      ":matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression) > AssignmentPattern[left.typeAnnotation.typeAnnotation.typeName.name='Translate']",
    message:
      "Translate parameters must be required. Pass the request/provider-bound translator explicitly.",
  },
  {
    selector:
      ":matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression) > Identifier[optional=true][typeAnnotation.typeAnnotation.typeName.name='Translate']",
    message:
      "Translate parameters must be required. Pass the request/provider-bound translator explicitly.",
  },
  {
    selector:
      "TSPropertySignature[optional=true][key.name=/^(t|translate)$/]:has(TSTypeReference[typeName.name='Translate'])",
    message:
      "Translate options must be required. Pass the request/provider-bound translator explicitly.",
  },
  // A client component must read its request-provided locale from context.
  // Importing a module-level translator bypasses the provider and previously
  // made concurrent server renders share mutable locale state.
  {
    selector:
      "Program:has(> ExpressionStatement[expression.value='use client']) ImportDeclaration[source.value='@/i18n'] ImportSpecifier[imported.name=/^(t|translate|tDynamic)$/]",
    message:
      "Client components must use useTranslation() so translation stays bound to their I18nProvider locale.",
  },
  // Error copy often reaches JSX indirectly through state or callbacks, so
  // the JSX guards below cannot see it. Keep literals out of error setters,
  // nested `{ message }` state objects and `onError()` callback boundaries.
  {
    selector:
      "CallExpression[callee.name=/^set[A-Z][A-Za-z]*(Error|Message|Banner|Notice|Toast)[A-Za-z]*$/] > Literal[value=/[A-Za-z]{2,}/]",
    message:
      "Wrap rider-facing error state with t()/tDynamic before passing it to the setter.",
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
    message: "Wrap every rider-facing error-state branch with t()/tDynamic.",
  },
  {
    selector:
      "CallExpression[callee.name=/^set[A-Z][A-Za-z]*(Error|Message|Banner|Notice|Toast)[A-Za-z]*$/] MemberExpression[computed=false][property.name='message']",
    message:
      "Do not expose arbitrary Error.message text. Use getUserFacingErrorMessage(error, t(…)) so only cataloged API errors pass through.",
  },
  {
    selector:
      "CallExpression[callee.name=/^set[A-Z]/] Property[key.name=/^(error|message|description)$/] > Literal[value=/[A-Za-z]{2,}/]",
    message:
      "Wrap rider-facing copy nested in state objects with t()/tDynamic before passing it to the setter.",
  },
  {
    selector:
      "CallExpression[callee.name=/^set[A-Z]/] Property[key.name=/^(error|message|description)$/] > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
    message:
      "Compose rider-facing copy nested in state objects through one ICU catalog message.",
  },
  {
    selector:
      "CallExpression[callee.object.name='toast'][callee.property.name=/^(error|success|info|warning)$/] MemberExpression[computed=false][property.name='message']",
    message:
      "Do not expose arbitrary Error.message text in toasts. Use getUserFacingErrorMessage with translated fallback copy.",
  },
  {
    selector:
      "Property[key.name=/^(error|message|description)$/] MemberExpression[computed=false][property.name='message']",
    message:
      "Do not store arbitrary Error.message text in rider-facing state. Use getUserFacingErrorMessage with translated fallback copy.",
  },
  {
    selector: "Property[key.name='message'] > Literal[value=/[A-Za-z]{2,}/]",
    message:
      "Route rider-facing message properties through t()/tDynamic. Document a scoped exception for non-display protocol data.",
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
      "Wrap every rider-facing message-property branch with t()/tDynamic.",
  },
  {
    selector:
      "CallExpression[callee.property.name='onError'] > Literal[value=/[A-Za-z]{2,}/]",
    message: "Wrap rider-facing onError() copy with t()/tDynamic.",
  },
  // Display helpers are another translation boundary: returning prose from a
  // function and later interpolating the result bypasses every JSX-literal
  // selector below. Semantic enum/token helpers should use names that do not
  // end in Label/Message/Copy/Text/Title/Description/Unit/Short.
  {
    selector:
      "FunctionDeclaration[id.name=/(Label|Message|Copy|Text|Title|Description|Unit|Short)$/]:not(:has(TSTypeReference[typeName.name='EnglishMessageKey'])) ReturnStatement > Literal[value=/[A-Za-z]{2,}/]",
    message:
      "Display helpers must return t()-cataloged copy, not raw prose. Return an EnglishMessageKey for translation at the caller, or document a non-display token.",
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
      "Display helpers must return t()-cataloged copy, not raw prose. Return an EnglishMessageKey for translation at the caller, or document a non-display token.",
  },
  {
    selector:
      "VariableDeclarator[id.name=/(Label|Message|Copy|Text|Title|Description|Unit|Short)$/] > :matches(ArrowFunctionExpression, FunctionExpression):not(:has(TSTypeReference[typeName.name='EnglishMessageKey'])) > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/], VariableDeclarator[id.name=/(Label|Message|Copy|Text|Title|Description|Unit|Short)$/] > :matches(ArrowFunctionExpression, FunctionExpression):not(:has(TSTypeReference[typeName.name='EnglishMessageKey'])) ReturnStatement > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
    message:
      "Display helpers must compose rider-facing templates through one ICU catalog message.",
  },
  {
    selector:
      "FunctionDeclaration[id.name=/(Label|Message|Copy|Text|Title|Description|Unit|Short|Display)$/] ReturnStatement > Identifier[name=/^(role|status|surface|severity|tier|type|reason|metric|category|season|condition|kind|source)$/], FunctionDeclaration[id.name=/(Label|Message|Copy|Text|Title|Description|Unit|Short|Display)$/] ReturnStatement > :matches(ConditionalExpression, LogicalExpression) > Identifier[name=/^(role|status|surface|severity|tier|type|reason|metric|category|season|condition|kind|source)$/], FunctionDeclaration[id.name=/(Label|Message|Copy|Text|Title|Description|Unit|Short|Display)$/] ReturnStatement > MemberExpression[computed=false][property.name=/^(role|status|surface|severity|tier|type|reason|metric|category|season|condition|kind|source)$/], FunctionDeclaration[id.name=/(Label|Message|Copy|Text|Title|Description|Unit|Short|Display)$/] ReturnStatement > :matches(ConditionalExpression, LogicalExpression) > MemberExpression[computed=false][property.name=/^(role|status|surface|severity|tier|type|reason|metric|category|season|condition|kind|source)$/]",
    message:
      "Display helpers must not return raw semantic wire values. Resolve them through a cataloged label map with an Unknown fallback.",
  },
  {
    selector:
      "VariableDeclarator[id.name=/(Label|Message|Copy|Text|Title|Description|Unit|Short|Display)$/] > :matches(ArrowFunctionExpression, FunctionExpression) > Identifier[name=/^(role|status|surface|severity|tier|type|reason|metric|category|season|condition|kind|source)$/], VariableDeclarator[id.name=/(Label|Message|Copy|Text|Title|Description|Unit|Short|Display)$/] > :matches(ArrowFunctionExpression, FunctionExpression) ReturnStatement > Identifier[name=/^(role|status|surface|severity|tier|type|reason|metric|category|season|condition|kind|source)$/], VariableDeclarator[id.name=/(Label|Message|Copy|Text|Title|Description|Unit|Short|Display)$/] > :matches(ArrowFunctionExpression, FunctionExpression) ReturnStatement > :matches(ConditionalExpression, LogicalExpression) > Identifier[name=/^(role|status|surface|severity|tier|type|reason|metric|category|season|condition|kind|source)$/], VariableDeclarator[id.name=/(Label|Message|Copy|Text|Title|Description|Unit|Short|Display)$/] > :matches(ArrowFunctionExpression, FunctionExpression) ReturnStatement > MemberExpression[computed=false][property.name=/^(role|status|surface|severity|tier|type|reason|metric|category|season|condition|kind|source)$/]",
    message:
      "Display helpers must not return raw semantic wire values. Resolve them through a cataloged label map with an Unknown fallback.",
  },
  {
    selector:
      "CallExpression[callee.name=/^(t|translate|localize)$/] > ObjectExpression > Property[key.name=/^(role|status|surface|severity|tier|type|reason|metric|category|season|condition|kind|source)$/][value.type='Identifier'][value.name=/^(role|status|surface|severity|tier|type|reason|metric|category|season|condition|kind|source)$/], CallExpression[callee.name=/^(t|translate|localize)$/] > ObjectExpression > Property[key.name=/^(role|status|surface|severity|tier|type|reason|metric|category|season|condition|kind|source)$/][value.type='MemberExpression'][value.computed=false][value.property.name=/^(role|status|surface|severity|tier|type|reason|metric|category|season|condition|kind|source)$/]",
    message:
      "Translate semantic wire values through a cataloged label map before using them in an ICU placeholder.",
  },
  {
    selector:
      "CallExpression[callee.name=/^(t|translate|localize)$/] > ObjectExpression > Property[key.name=/^(action|event|operation|phase|mode|state)$/][value.type='Identifier'], CallExpression[callee.name=/^(t|translate|localize)$/] > ObjectExpression > Property[key.name=/^(action|event|operation|phase|mode|state)$/][value.type='MemberExpression']",
    message:
      "Do not interpolate semantic wire actions or states into translated copy. Resolve a cataloged label or use a cataloged unknown fallback.",
  },
  // Guard the #861 migration: the companion talks to the backend only
  // through the generated OpenAPI client. Flag any raw `fetch()` whose URL
  // is built from an API base/host so a new raw helper can't creep back in.
  {
    selector:
      "CallExpression[callee.name='fetch'] > TemplateLiteral > Identifier[name=/^API_(BASE|HOST)/]",
    message:
      "Don't fetch the backend directly. Use the generated client — `api` / `apiServer` from `@/lib/api` (see #861).",
  },
  // Guard the form-control migration (#1006/#1008): rider-facing form
  // fields render through @tarmoto/ui (Input, PasswordInput, Select,
  // Combobox, Textarea, Checkbox, DatePicker, CopyField, …) so the
  // field chrome stays consistent. Deliberate native elements — hidden
  // file pickers, sr-only AT/test bridges, dark-theme road/embed
  // surfaces, bespoke inline editors — carry a disable comment stating
  // the reason.
  {
    selector: "JSXOpeningElement[name.name='input']",
    message:
      "Use a @tarmoto/ui form control instead of a native <input>. If this element is deliberate (hidden file picker, sr-only bridge, dark surface, inline editor), add a disable comment with the reason.",
  },
  {
    selector: "JSXOpeningElement[name.name='select']",
    message:
      "Use @tarmoto/ui Select/Combobox instead of a native <select>. If this element is deliberate (sr-only bridge), add a disable comment with the reason.",
  },
  {
    selector: "JSXOpeningElement[name.name='textarea']",
    message:
      "Use @tarmoto/ui Textarea instead of a native <textarea>. If this element is deliberate (dark surface, read-only embed code), add a disable comment with the reason.",
  },
  // i18n bypass guard (PR 3b): user-facing text on these JSX props must go
  // through t()/tDynamic, not a raw string literal — the typed t() flip
  // cannot catch a string that never reaches t(). Flags a string literal
  // (direct or in braces) that starts with a letter, so symbols, empty
  // alt="", and interpolated/`t(...)` values pass. Deliberate raw text
  // (a brand name, a non-translatable token) carries a disable comment.
  // `ariaLabel` (camelCase) is the @tarmoto/ui prop name, alongside the
  // kebab-case DOM `aria-label` used on native/passthrough elements.
  {
    selector:
      "JSXAttribute[name.name=/^(label|title|alt|placeholder|aria-label|ariaLabel)$/] > Literal[value=/^[A-Za-z]/]",
    message:
      "Wrap user-facing text on label/title/alt/placeholder/aria-label/ariaLabel with t() (or tDynamic for a runtime key). If this literal is deliberately not translatable, add a disable comment with the reason.",
  },
  {
    selector:
      "JSXAttribute[name.name=/^(label|title|alt|placeholder|aria-label|ariaLabel)$/] > JSXExpressionContainer > Literal[value=/^[A-Za-z]/]",
    message:
      "Wrap user-facing text on label/title/alt/placeholder/aria-label/ariaLabel with t() (or tDynamic for a runtime key). If this literal is deliberately not translatable, add a disable comment with the reason.",
  },
  // Same guard for the non-literal prop shapes the plain-Literal selectors
  // above can't see: a template literal with raw static text
  // (`label={`Force ${n}`}`) and a raw string / template in a conditional
  // branch (`label={cond ? "Add" : "Save"}`). The conditional selectors use a
  // DESCENDANT match (`JSXAttribute … ConditionalExpression > …`) so NESTED
  // ternaries can't slip an inner raw branch through
  // (`label={ok ? t("K") : flag ? "Add" : "Save"}`). Scoping to a direct
  // child of `ConditionalExpression`/the expression container (not a bare
  // descendant Literal) means a Literal/TemplateLiteral that is a t()
  // ARGUMENT is not matched, so t()-wrapped branches and t()-composed
  // templates (`label={`${t("X")} (${n})`}`, no 2+-letter static run) pass.
  {
    selector:
      "JSXAttribute[name.name=/^(label|title|alt|placeholder|aria-label|ariaLabel)$/] > JSXExpressionContainer > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
    message:
      'Raw user-facing text in a template literal on label/title/alt/placeholder/aria-label/ariaLabel — compose it through t()/tDynamic (`${t("…")}`), or add a disable comment if deliberately not translatable.',
  },
  {
    selector:
      "JSXAttribute[name.name=/^(label|title|alt|placeholder|aria-label|ariaLabel)$/] ConditionalExpression > Literal[value=/^[A-Za-z]/]",
    message:
      'Raw string literal in a conditional (any nesting) on label/title/alt/placeholder/aria-label/ariaLabel — wrap each branch with t()/tDynamic (`cond ? t("A") : t("B")`), or add a disable comment if deliberate.',
  },
  {
    selector:
      "JSXAttribute[name.name=/^(label|title|alt|placeholder|aria-label|ariaLabel)$/] ConditionalExpression > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
    message:
      "Raw user-facing text in a conditional template branch (any nesting) on label/title/alt/placeholder/aria-label/ariaLabel — compose it through t()/tDynamic, or add a disable comment if deliberate.",
  },
  // Match the mobile guard's wider bypass coverage. Raw JSX children are the
  // largest remaining hole in the companion: typed t() cannot protect copy
  // that never reaches the catalog.
  {
    selector: "JSXText[value=/[A-Za-z]{2,}/]",
    message:
      "Wrap user-facing JSX text with t()/tDynamic. If deliberately not translatable (brand, unit, attribution), add a scoped disable comment explaining why.",
  },
  {
    selector:
      "JSXElement > JSXExpressionContainer > Literal[value=/[A-Za-z]{2,}/]",
    message:
      "Wrap user-facing string children with t()/tDynamic, or document a deliberate non-translatable value.",
  },
  {
    selector:
      "JSXElement > JSXExpressionContainer > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
    message:
      "Replace rider-facing JSX templates with one ICU catalog message and named values.",
  },
  {
    selector:
      "JSXElement > JSXExpressionContainer > ConditionalExpression > Literal[value=/[A-Za-z]{2,}/]",
    message:
      "Wrap every rider-facing conditional JSX branch with t()/tDynamic.",
  },
  {
    selector:
      "JSXElement > JSXExpressionContainer > ConditionalExpression > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
    message:
      "Replace conditional rider-facing JSX templates with ICU catalog messages.",
  },
  {
    selector:
      "JSXElement > JSXExpressionContainer > MemberExpression[computed=false][property.name=/(^|_)(status|surface|severity|tier|role|type|reason|metric)$/]",
    message:
      "Translate stable enum/wire values through a cataloged label map before rendering them.",
  },
  {
    selector:
      "JSXOpeningElement[name.name='UserAvatar'] JSXAttribute[name.name='name'] ConditionalExpression > Literal[value=/[A-Za-z]{2,}/]",
    message:
      "Translate static self/avatar names before passing them to UserAvatar; the value also becomes image alt text.",
  },
  {
    selector:
      "CallExpression[callee.object.name=/^(role|status|surface|severity|tier|type|reason|metric)$/][callee.property.name=/^(toUpperCase|toLocaleUpperCase)$/]",
    message:
      "Translate semantic enum values through a cataloged label map before changing display case.",
  },
  {
    selector:
      "Property[key.name='name'] > Literal[value=/^(New Trip|Start|Finish|Reroute via|Twisty highlight|Unnamed)$/]",
    message:
      "Do not persist generated English display labels in domain data. Store semantic state and translate at the render boundary.",
  },
  {
    selector:
      "JSXElement > JSXExpressionContainer > LogicalExpression > Literal[value=/[A-Za-z]{2,}/]",
    message:
      "Wrap rider-facing logical fallback copy with t()/tDynamic instead of rendering a raw string.",
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
      "Format rider-facing numbers with useFormat()/getServerFormatters() instead of toFixed().",
  },
  {
    selector:
      "JSXAttribute[name.name=/^(accessibilityHint|accessibilityLabel|actionLabel|body|cancelText|caption|confirmText|content|delta|description|emptyText|headerTitle|headline|helpText|message|subtitle|tabBarLabel|text)$/] > Literal[value=/[A-Za-z]{2,}/]",
    message:
      "Wrap rider-facing prop copy with t()/tDynamic, or document a deliberate non-translatable value.",
  },
  {
    selector:
      "JSXAttribute[name.name=/^(accessibilityHint|accessibilityLabel|actionLabel|body|cancelText|caption|confirmText|content|delta|description|emptyText|headerTitle|headline|helpText|message|subtitle|tabBarLabel|text)$/] > JSXExpressionContainer > Literal[value=/[A-Za-z]{2,}/]",
    message:
      "Wrap rider-facing prop copy with t()/tDynamic, or document a deliberate non-translatable value.",
  },
  {
    selector:
      "JSXAttribute[name.name=/^(accessibilityHint|accessibilityLabel|actionLabel|body|cancelText|caption|confirmText|content|delta|description|emptyText|headerTitle|headline|helpText|message|subtitle|tabBarLabel|text)$/] > JSXExpressionContainer > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
    message:
      "Replace rider-facing prop templates with one ICU catalog message and named values.",
  },
  {
    selector:
      "JSXAttribute[name.name=/^(accessibilityHint|accessibilityLabel|actionLabel|body|cancelText|caption|confirmText|content|delta|description|emptyText|headerTitle|headline|helpText|message|subtitle|tabBarLabel|text)$/] ConditionalExpression > Literal[value=/[A-Za-z]{2,}/]",
    message:
      "Wrap every rider-facing conditional prop branch with t()/tDynamic.",
  },
  {
    selector:
      "JSXAttribute[name.name=/^(accessibilityHint|accessibilityLabel|actionLabel|body|cancelText|caption|confirmText|content|delta|description|emptyText|headerTitle|headline|helpText|message|subtitle|tabBarLabel|text)$/] ConditionalExpression > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
    message:
      "Replace conditional rider-facing prop templates with one ICU catalog message.",
  },
  {
    selector:
      "JSXAttribute[name.name=/^(label|title|alt|placeholder|aria-label|ariaLabel|accessibilityHint|accessibilityLabel|actionLabel|body|cancelText|caption|confirmText|content|delta|description|emptyText|headerTitle|headline|helpText|message|subtitle|tabBarLabel|text)$/] > JSXExpressionContainer > BinaryExpression Literal[value=/[A-Za-z]{2,}/]",
    message:
      "Replace concatenated rider-facing prop copy with one ICU catalog message and named values.",
  },
  {
    selector:
      "JSXAttribute[name.name=/^(label|title|alt|placeholder|aria-label|ariaLabel|accessibilityHint|accessibilityLabel|actionLabel|body|cancelText|caption|confirmText|content|delta|description|emptyText|headerTitle|headline|helpText|message|subtitle|tabBarLabel|text)$/] > JSXExpressionContainer > BinaryExpression TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
    message:
      "Replace concatenated rider-facing prop templates with one ICU catalog message.",
  },
  {
    selector:
      "CallExpression[callee.name=/^set.*(Error|Message|Notice|Validation|Warning)$/] > Literal[value=/[A-Za-z]{2,}/]",
    message: "Wrap rider-facing status messages with t()/tDynamic.",
  },
  {
    selector:
      "CallExpression[callee.name=/^set.*(Error|Message|Notice|Validation|Warning)$/] > ConditionalExpression > Literal[value=/[A-Za-z]{2,}/]",
    message:
      "Wrap every rider-facing conditional status message with t()/tDynamic.",
  },
  {
    selector:
      "CallExpression[callee.name=/^set.*(Error|Message|Notice|Validation|Warning)$/] LogicalExpression > Literal[value=/[A-Za-z]{2,}/]",
    message: "Wrap rider-facing logical fallback messages with t()/tDynamic.",
  },
  {
    selector:
      "VariableDeclarator[id.name=/^(error|errorMessage|message|notice|validation|warning)$/] > ConditionalExpression > Literal[value=/[A-Za-z]{2,}/]",
    message:
      "Wrap rider-facing conditional status-copy variables with t()/tDynamic.",
  },
  {
    selector:
      "VariableDeclarator[id.name=/^(error|errorMessage|message|notice|validation|warning)$/] > ConditionalExpression > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
    message:
      "Replace conditional rider-facing status templates with one ICU catalog message.",
  },
  {
    selector:
      "VariableDeclarator[id.name=/^(description|emptyText|headline|helpText|label|message|subtitle|title)$/] ConditionalExpression > Literal[value=/[A-Za-z]{2,}/]",
    message: "Wrap conditional rider-facing copy variables with t()/tDynamic.",
  },
  {
    selector:
      "VariableDeclarator[id.name=/^(description|emptyText|headline|helpText|label|message|subtitle|title)$/] ConditionalExpression > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
    message:
      "Replace conditional rider-facing copy templates with one ICU catalog message.",
  },
  // Display copy is sometimes assigned to a descriptive local before JSX
  // renders it. Cover the common semantic names without matching protocol
  // names such as iconName, filename, route layer IDs, or CSS class tokens.
  {
    selector:
      "VariableDeclarator[id.name=/(^title$|Title$|Label$|displayName$|fallbackName$|rideName$)/] > Literal[value=/[A-Za-z]{2,}/], VariableDeclarator[id.name=/(^title$|Title$|Label$|displayName$|fallbackName$|rideName$)/] > :matches(ConditionalExpression, LogicalExpression) > Literal[value=/[A-Za-z]{2,}/]",
    message: "Translate rider-facing display variables before rendering them.",
  },
  {
    selector:
      "VariableDeclarator[id.name=/(^title$|Title$|Label$|displayName$|fallbackName$|rideName$)/] > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/], VariableDeclarator[id.name=/(^title$|Title$|Label$|displayName$|fallbackName$|rideName$)/] > :matches(ConditionalExpression, LogicalExpression) > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
    message:
      "Compose rider-facing display-variable templates through one ICU catalog message.",
  },
  {
    selector:
      "JSXElement > JSXExpressionContainer > Identifier[name=/(count|Count|total|Total|rank|Rank|year|Year|day|Day|page|Page|rating|Rating|score|Score|percent|Percent|index|Index)$/]",
    message:
      "Format directly rendered numeric values with the active regional formatter.",
  },
  {
    selector:
      "JSXElement > JSXExpressionContainer > LogicalExpression > Identifier[name=/(count|Count|total|Total|rank|Rank|year|Year|day|Day|days|Days|page|Page|rating|Rating|score|Score|percent|Percent|index|Index)$/]",
    message:
      "Format numeric branches of directly rendered expressions with the active regional formatter.",
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
    selector:
      "CallExpression[callee.object.property.name='unit'][callee.property.name=/^(toUpperCase|toLowerCase|toLocaleUpperCase|toLocaleLowerCase)$/]",
    message:
      "Render compact measurement abbreviations with format.unitLabel() so locale-sensitive casing cannot corrupt unit symbols.",
  },
  {
    selector:
      "JSXOpeningElement[name.name=/^(Area|Bar|Line)$/] JSXAttribute[name.name='name'] > Literal[value=/[A-Za-z]{2,}/]",
    message: "Translate chart series names before passing them to Recharts.",
  },
  {
    selector:
      "JSXOpeningElement[name.name='Tooltip'] JSXAttribute[name.name='formatter'] ArrayExpression > Literal[value=/[A-Za-z]{2,}/]",
    message:
      "Translate chart tooltip labels instead of returning raw display copy.",
  },
  {
    selector:
      "JSXOpeningElement[name.name=/^(XAxis|YAxis)$/] JSXAttribute[name.name='tickFormatter'] CallExpression[callee.object.name='Math'][callee.property.name='round']",
    message:
      "Format chart ticks with the active regional formatter instead of Math.round().",
  },
  {
    selector:
      "JSXElement > JSXExpressionContainer > MemberExpression[computed=false][object.name=/^(metric|stat)$/][property.name='key']",
    message:
      "Render a translated display label, not a configuration or protocol key.",
  },
];

export default [
  {
    ignores: [
      ".next/**",
      // Dev output of the pseudo-translation e2e server (see
      // playwright.pseudo.config.ts / next.config.ts distDir quarantine).
      ".next-pseudo/**",
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
    // The service worker runs in a ServiceWorkerGlobalScope, not the DOM or
    // Node — declare its globals so `no-undef` doesn't flag `self`/`caches`.
    files: ["public/sw.js"],
    languageOptions: {
      globals: {
        self: "readonly",
        caches: "readonly",
        fetch: "readonly",
        URL: "readonly",
        Response: "readonly",
        Request: "readonly",
      },
    },
  },
  {
    files: ["**/*.{ts,tsx,js,jsx}"],
    ignores: [
      "**/__tests__/**/*.{ts,tsx,js,jsx}",
      "**/*.test.{ts,tsx,js,jsx}",
      "**/*.spec.{ts,tsx,js,jsx}",
    ],
    plugins: {
      "@next/next": next,
      "react-hooks": reactHooks,
      "tarmoto-localization": localizationPlugin,
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
      "tarmoto-localization/no-locale-insensitive-collation": "error",
      "tarmoto-localization/no-locale-insensitive-search": "error",
      "tarmoto-localization/no-react-global-formatter": "error",
      "tarmoto-localization/no-react-global-translator": "error",
      "tarmoto-localization/no-translated-fragments": "error",
      "tarmoto-localization/no-uncataloged-directional-copy": "error",
      "tarmoto-localization/no-visible-numeric-jsx-text": "error",
      "tarmoto-localization/require-locale-hook-dependencies": "error",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-restricted-syntax": ["error", ...restrictedSyntaxSelectors],
    },
  },
  {
    // Test fixtures intentionally render and assert English literals. Keep the
    // production i18n bypass guard out of tests while retaining the repository
    // unused-fixture convention.
    files: [
      "**/__tests__/**/*.{ts,tsx,js,jsx}",
      "**/*.test.{ts,tsx,js,jsx}",
      "**/*.spec.{ts,tsx,js,jsx}",
    ],
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-restricted-syntax": "off",
      "tarmoto-localization/no-locale-insensitive-search": "off",
      "tarmoto-localization/no-locale-insensitive-collation": "off",
      "tarmoto-localization/no-react-global-formatter": "off",
      "tarmoto-localization/no-react-global-translator": "off",
      "tarmoto-localization/no-translated-fragments": "off",
      "tarmoto-localization/no-uncataloged-directional-copy": "off",
      "tarmoto-localization/no-visible-numeric-jsx-text": "off",
      "tarmoto-localization/require-locale-hook-dependencies": "off",
    },
  },
  {
    // Locale-formatting guard: all display formatting goes through the
    // src/format seam (useFormat/getServerFormatters). Raw toLocale*/Intl
    // constructions bypass the rider's format preferences.
    //
    // NOTE: this object's `files` (src/**/*.{ts,tsx}) overlaps the guard
    // block above (**/*.{ts,tsx,js,jsx}), and ESLint flat config resolves two
    // matching configs that set the *same* rule key by letting the later one
    // win outright — it does not concatenate the `no-restricted-syntax`
    // option arrays. So this block re-spreads the shared
    // `restrictedSyntaxSelectors` (raw-fetch #861 + native-form-control
    // #1006/#1008) alongside its own locale selectors; dropping the spread
    // would silently turn those guards off for every file this block also
    // matches.
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/format/**",
      "src/**/*.test.{ts,tsx}",
      "src/**/*.spec.{ts,tsx}",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...restrictedSyntaxSelectors,
        {
          selector: "CallExpression[callee.property.name='toLocaleString']",
          message:
            "Use useFormat()/getServerFormatters() (src/format) instead of toLocaleString — it applies the rider's format preferences.",
        },
        {
          selector: "CallExpression[callee.property.name='toLocaleDateString']",
          message:
            "Use format.date()/shortDate()/calendarDate() from src/format instead of toLocaleDateString.",
        },
        {
          selector: "CallExpression[callee.property.name='toLocaleTimeString']",
          message: "Use format.time()/dateTime() from src/format.",
        },
        {
          selector: "NewExpression[callee.object.name='Intl']",
          message:
            "Construct Intl formatters only inside src/format (the seam memoizes and applies preferences). Timezone DETECTION via Intl.DateTimeFormat().resolvedOptions() without `new` remains allowed.",
        },
        {
          selector:
            "CallExpression[callee.object.name='Intl'][callee.property.name='NumberFormat']",
          message:
            "Construct number formatters only inside src/format — Intl.NumberFormat() without new bypasses the rider's format preferences.",
        },
      ],
    },
  },
];
