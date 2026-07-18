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

// Shared by both `no-restricted-syntax` blocks below (the broad
// **/*.{ts,tsx,js,jsx} block and the src-scoped block). Flat config resolves
// two matching configs that set the *same* rule key by letting the later one
// win outright — it does not concatenate `no-restricted-syntax` option
// arrays — so the src-scoped block must re-list these selectors (plus its own
// locale-formatting additions) rather than relying on the broad block. A
// single shared array keeps the two copies from drifting out of sync.
const restrictedSyntaxSelectors = [
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
  // (`label={`Force ${n}`}`) and a conditional with a raw string branch
  // (`label={cond ? "Add" : "Save"}`). A t()-composed template
  // (`label={`${t("X")} (${n})`}`, no 2+-letter static run) and a
  // t()-wrapped conditional (CallExpression branches) both pass.
  {
    selector:
      "JSXAttribute[name.name=/^(label|title|alt|placeholder|aria-label|ariaLabel)$/] > JSXExpressionContainer > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2,}/]",
    message:
      'Raw user-facing text in a template literal on label/title/alt/placeholder/aria-label/ariaLabel — compose it through t()/tDynamic (`${t("…")}`), or add a disable comment if deliberately not translatable.',
  },
  {
    selector:
      "JSXAttribute[name.name=/^(label|title|alt|placeholder|aria-label|ariaLabel)$/] > JSXExpressionContainer > ConditionalExpression > Literal[value=/^[A-Za-z]/]",
    message:
      'Raw string literal in a conditional on label/title/alt/placeholder/aria-label/ariaLabel — wrap each branch with t()/tDynamic (`cond ? t("A") : t("B")`), or add a disable comment if deliberate.',
  },
];

export default [
  {
    ignores: [
      ".next/**",
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
    files: ["**/*.{ts,tsx,js,jsx}"],
    plugins: {
      "@next/next": next,
      "react-hooks": reactHooks,
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
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-restricted-syntax": ["error", ...restrictedSyntaxSelectors],
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
