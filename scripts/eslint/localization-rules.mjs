const TRANSLATOR_NAMES = new Set(["t", "translate", "tDynamic"]);
const INLINE_TEXT_ELEMENTS = new Set([
  "a",
  "b",
  "em",
  "i",
  "Link",
  "Mono",
  "span",
  "strong",
  "Text",
]);
const TEXT_CONTAINER_ELEMENTS = new Set([
  "a",
  "b",
  "button",
  "em",
  "FieldLabel",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "label",
  "Link",
  "Mono",
  "p",
  "span",
  "Stamp",
  "strong",
  "Text",
]);

function jsxElementName(openingElement) {
  const { name } = openingElement;
  return name.type === "JSXIdentifier" ? name.name : null;
}

function containsJsx(node) {
  if (!node || typeof node !== "object") return false;
  if (node.type === "JSXElement" || node.type === "JSXFragment") return true;
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || key === "loc" || key === "range") continue;
    if (Array.isArray(value)) {
      if (value.some(containsJsx)) return true;
    } else if (containsJsx(value)) {
      return true;
    }
  }
  return false;
}

function containsTranslatorCall(node) {
  if (!node || typeof node !== "object") return false;
  // A conditional/list expression that returns complete JSX blocks is layout,
  // not an inline sentence. Those nested elements are visited independently.
  if (node.type === "JSXElement" || node.type === "JSXFragment") return false;
  if (
    node.type === "CallExpression" &&
    node.callee?.type === "Identifier" &&
    TRANSLATOR_NAMES.has(node.callee.name)
  ) {
    return true;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || key === "loc" || key === "range") continue;
    if (Array.isArray(value)) {
      if (value.some(containsTranslatorCall)) return true;
    } else if (containsTranslatorCall(value)) {
      return true;
    }
  }
  return false;
}

function isTextualSibling(child) {
  if (child.type === "JSXText") return child.value.trim() !== "";
  if (child.type === "JSXElement") {
    return (
      INLINE_TEXT_ELEMENTS.has(jsxElementName(child.openingElement)) &&
      child.children.some(isTextualSibling)
    );
  }
  if (child.type !== "JSXExpressionContainer") return false;
  const expression = child.expression;
  if (!expression || expression.type === "JSXEmptyExpression") return false;
  if (
    expression.type === "Literal" &&
    typeof expression.value === "string" &&
    expression.value.trim() === ""
  ) {
    return false;
  }
  // Icons and mapped component collections are layout siblings, not sentence
  // fragments. Inline JSX is covered above when it is a direct element.
  return !containsJsx(expression);
}

function containsIndependentSeparator(node) {
  if (!node || typeof node !== "object") return false;
  if (
    (node.type === "JSXText" && /[·—]/.test(node.value)) ||
    (node.type === "Literal" &&
      typeof node.value === "string" &&
      /[·—]/.test(node.value)) ||
    (node.type === "TemplateElement" &&
      /[·—]|\\u00[bB]7/.test(node.value.raw))
  ) {
    return true;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || key === "loc" || key === "range") continue;
    if (Array.isArray(value)) {
      if (value.some(containsIndependentSeparator)) return true;
    } else if (containsIndependentSeparator(value)) {
      return true;
    }
  }
  return false;
}

const noTranslatedFragments = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require complete catalog messages instead of translated sentence fragments.",
    },
    messages: {
      fragment:
        "Do not assemble one sentence from translated fragments. Use one ICU message with named values so translators can reorder the copy.",
    },
    schema: [],
  },
  create(context) {
    return {
      JSXElement(node) {
        if (
          !TEXT_CONTAINER_ELEMENTS.has(
            jsxElementName(node.openingElement),
          )
        ) {
          return;
        }
        const translatedChildren = node.children.filter(
          (child) =>
            child.type === "JSXExpressionContainer" &&
            containsTranslatorCall(child.expression),
        );
        if (translatedChildren.length === 0) return;

        const hasAnotherTextPart = node.children.some(
          (child) =>
            !translatedChildren.includes(child) && isTextualSibling(child),
        );
        if (!hasAnotherTextPart && translatedChildren.length === 1) return;
        // Compact metric/status rows are deliberately independent atoms. A
        // middle-dot or em-dash separator makes that explicit and keeps the
        // rule focused on grammatical fragments that must be reorderable.
        if (
          node.children.some(
            (child) =>
              !translatedChildren.includes(child) &&
              containsIndependentSeparator(child),
          )
        ) {
          return;
        }

        for (const child of translatedChildren) {
          context.report({ node: child, messageId: "fragment" });
        }
      },
    };
  },
};

const noVisibleNumericJsxText = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require regionally formatted numerals for visible JSX text.",
    },
    messages: {
      numeric:
        "Visible numeric JSX text must use the active regional formatter or a catalog placeholder.",
    },
    schema: [],
  },
  create(context) {
    return {
      JSXText(node) {
        if (/\d/.test(node.value)) {
          context.report({ node, messageId: "numeric" });
        }
      },
    };
  },
};

const noLocaleInsensitiveSearch = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require explicit locale-aware normalization in rider-facing search.",
    },
    messages: {
      search:
        "Rider-facing search and matching must use normalizeForLocaleSearch() with the active locale, not toLowerCase().",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type !== "MemberExpression" ||
          node.callee.computed ||
          node.callee.property.type !== "Identifier" ||
          node.callee.property.name !== "toLowerCase"
        ) {
          return;
        }
        // Deliberately reject every unqualified lower-case conversion in app
        // production code. Search semantics cannot be inferred reliably from
        // variable/function names. Machine-token normalization is a narrow
        // exception and must carry an explicit ESLint suppression at its call
        // site so reviewers can distinguish it from rider-facing text.
        context.report({ node, messageId: "search" });
      },
    };
  },
};

export const localizationPlugin = {
  rules: {
    "no-locale-insensitive-search": noLocaleInsensitiveSearch,
    "no-translated-fragments": noTranslatedFragments,
    "no-visible-numeric-jsx-text": noVisibleNumericJsxText,
  },
};
