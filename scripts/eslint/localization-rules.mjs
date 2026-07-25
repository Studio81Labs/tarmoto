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
const FORMATTING_INLINE_ELEMENTS = INLINE_TEXT_ELEMENTS;
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

function staticClassName(openingElement) {
  const attribute = openingElement.attributes.find(
    (candidate) =>
      candidate.type === "JSXAttribute" &&
      candidate.name.type === "JSXIdentifier" &&
      candidate.name.name === "className",
  );
  const value = attribute?.value;
  if (!value) return "";
  if (value.type === "Literal" && typeof value.value === "string") {
    return value.value;
  }
  if (value.type !== "JSXExpressionContainer") return "";
  const expression = value.expression;
  if (
    expression.type === "Literal" &&
    typeof expression.value === "string"
  ) {
    return expression.value;
  }
  if (expression.type === "TemplateLiteral") {
    return expression.quasis.map((quasi) => quasi.value.raw).join(" ");
  }
  return "";
}

function hasLayoutDisplayClass(node) {
  return (
    node.type === "JSXElement" &&
    /(?:^|\s)(?:[a-z0-9-]+:)*(?:block|flex|grid|inline-flex|inline-grid)(?:\s|$)/i.test(
      staticClassName(node.openingElement),
    )
  );
}

function isFormattingInlineElement(node) {
  if (node.type !== "JSXElement") return false;
  const name = jsxElementName(node.openingElement);
  if (!FORMATTING_INLINE_ELEMENTS.has(name)) return false;
  // A semantic inline tag can still be deliberately promoted to a layout
  // row/block. Its translated descendants are independent display atoms, not
  // fragments of the parent's grammar.
  return !hasLayoutDisplayClass(node);
}

function containsTranslatorInInlineJsx(node) {
  if (node.type === "JSXExpressionContainer") {
    return (
      !containsJsx(node.expression) &&
      containsTranslatorCall(node.expression)
    );
  }
  if (!isFormattingInlineElement(node)) {
    return false;
  }
  return node.children.some(containsTranslatorInInlineJsx);
}

function isTranslatedChild(child) {
  return (
    (child.type === "JSXExpressionContainer" &&
      !containsJsx(child.expression) &&
      containsTranslatorCall(child.expression)) ||
    containsTranslatorInInlineJsx(child)
  );
}

function isTextualSibling(child) {
  if (child.type === "JSXText") return child.value.trim() !== "";
  if (child.type === "JSXElement") {
    if (hasLayoutDisplayClass(child)) return false;
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
    (node.type === "JSXText" && /[·—•]/.test(node.value)) ||
    (node.type === "Literal" &&
      typeof node.value === "string" &&
      /[·—•]/.test(node.value)) ||
    (node.type === "TemplateElement" &&
      /[·—•]|\\u00[bB]7|\\u2022/.test(node.value.raw))
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

function isTranslatedComposition(node) {
  if (!containsTranslatorCall(node)) return false;
  if (node.type === "BinaryExpression" && node.operator === "+") {
    return true;
  }
  if (node.type !== "TemplateLiteral") return false;
  const translatedExpressions = node.expressions.filter(containsTranslatorCall);
  return (
    node.quasis.some((quasi) => quasi.value.raw.trim() !== "") ||
    node.expressions.some(
      (expression) => !containsTranslatorCall(expression),
    ) ||
    translatedExpressions.length > 1
  );
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
          ) ||
          hasLayoutDisplayClass(node)
        ) {
          return;
        }
        const translatedChildren = node.children.filter(isTranslatedChild);
        if (translatedChildren.length === 0) return;
        const composedChildren = translatedChildren.filter(
          (child) =>
            child.type === "JSXExpressionContainer" &&
            isTranslatedComposition(child.expression),
        );

        const hasAnotherTextPart = node.children.some(
          (child) =>
            !translatedChildren.includes(child) && isTextualSibling(child),
        );
        if (
          composedChildren.length === 0 &&
          !hasAnotherTextPart &&
          translatedChildren.length === 1
        ) {
          return;
        }
        // Compact metric/status rows are deliberately independent atoms. A
        // middle-dot or em-dash separator makes that explicit and keeps the
        // rule focused on grammatical fragments that must be reorderable.
        if (
          composedChildren.length === 0 &&
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
      JSXExpressionContainer(node) {
        if (
          node.parent?.type !== "JSXElement" &&
          node.parent?.type !== "JSXFragment"
        ) {
          return;
        }
        const expression = node.expression;
        const isNumericLiteral =
          expression.type === "Literal" &&
          (typeof expression.value === "number" ||
            typeof expression.value === "bigint");
        const isSignedNumericLiteral =
          expression.type === "UnaryExpression" &&
          (expression.operator === "+" || expression.operator === "-") &&
          expression.argument.type === "Literal" &&
          typeof expression.argument.value === "number";
        if (isNumericLiteral || isSignedNumericLiteral) {
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
