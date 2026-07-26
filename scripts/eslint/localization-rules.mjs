const TRANSLATOR_NAMES = new Set([
  "localize",
  "t",
  "tDynamic",
  "translate",
  "translateHeader",
]);
const SEARCH_CASE_METHODS = new Set([
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "toLowerCase",
  "toUpperCase",
]);
const TRANSLATED_COMPOSITION_METHODS = new Set([
  "concat",
  "join",
  "padEnd",
  "padStart",
  "replace",
  "replaceAll",
]);
const NUMERIC_RECEIVER_DISPLAY_METHODS = new Set([
  "join",
  "toExponential",
  "toFixed",
  "toLocaleString",
  "toPrecision",
  "toString",
  "valueOf",
]);
const STANDALONE_REGIONAL_NUMERIC_FORMATTERS = new Set(["formatCount"]);
const REGIONAL_FORMATTER_METHODS = new Set([
  "calendarDate",
  "calendarDateRange",
  "currency",
  "date",
  "dateRange",
  "dateTime",
  "decimal",
  "distanceKm",
  "distanceM",
  "duration",
  "durationClock",
  "durationCompact",
  "elevation",
  "integer",
  "month",
  "monthYear",
  "monthYearCompact",
  "number",
  "percent",
  "relativeTime",
  "shortDate",
  "speed",
  "splitDistanceKm",
  "splitElevation",
  "splitSpeed",
  "temperature",
  "time",
  "unitLabel",
]);
// These operations can return values from their receiver unchanged. When the
// result is rendered directly, display-copy and numeral checks must therefore
// inspect the receiver as well as the call arguments. Transforming operations
// such as `map` stay out of this blanket set because their receiver values may
// only be structural inputs to independently rendered output; translated-copy
// analysis handles only demonstrably value-preserving map callbacks below.
const COLLECTION_VALUE_PRESERVING_METHODS = new Set([
  "at",
  "concat",
  "copyWithin",
  "filter",
  "find",
  "findLast",
  "flat",
  "pop",
  "reverse",
  "shift",
  "slice",
  "sort",
  "splice",
  "toReversed",
  "toSorted",
  "toSpliced",
  "with",
]);
const RENDERED_COLLECTION_TRANSFORM_METHODS = new Set(["flatMap", "map"]);
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
  "caption",
  "dd",
  "div",
  "dt",
  "em",
  "FieldLabel",
  "figcaption",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "label",
  "legend",
  "li",
  "Link",
  "mark",
  "Mono",
  "option",
  "p",
  "pre",
  "small",
  "span",
  "Stamp",
  "strong",
  "summary",
  "td",
  "Text",
  "th",
]);
const TEXTUAL_JSX_ATTRIBUTES = new Set([
  "accessibilityHint",
  "accessibilityLabel",
  "actionLabel",
  "alt",
  "aria-label",
  "ariaLabel",
  "body",
  "cancelText",
  "confirmText",
  "description",
  "emptyText",
  "headerTitle",
  "headline",
  "helpText",
  "label",
  "message",
  "placeholder",
  "subtitle",
  "tabBarLabel",
  "text",
  "title",
]);

function jsxElementName(openingElement) {
  const { name } = openingElement;
  return name.type === "JSXIdentifier" ? name.name : null;
}

function isTextualJsxAttribute(node) {
  return (
    node?.type === "JSXAttribute" &&
    node.name.type === "JSXIdentifier" &&
    TEXTUAL_JSX_ATTRIBUTES.has(node.name.name)
  );
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

function isTranslatorCall(node) {
  return (
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    TRANSLATOR_NAMES.has(node.callee.name)
  );
}

function translatorKeyHasUnformattedNumericLiteral(node) {
  if (!isTranslatorCall(node)) return false;
  const key = node.arguments[0];
  if (
    !key ||
    key.type !== "Literal" ||
    typeof key.value !== "string"
  ) {
    return false;
  }
  // ICU argument identifiers may themselves contain digits (`value0`), but
  // those values flow through IntlMessageFormat. Reject digit-only catalog
  // keys: catalog lookup alone cannot turn their ASCII glyphs into the active
  // regional numeral system.
  return /^\d+$/.test(key.value.trim());
}

function memberCallName(node) {
  if (node.type !== "CallExpression") return null;
  const callee = node.callee;
  if (callee.type !== "MemberExpression") return null;
  if (!callee.computed && callee.property.type === "Identifier") {
    return callee.property.name;
  }
  if (
    callee.computed &&
    callee.property.type === "Literal" &&
    typeof callee.property.value === "string"
  ) {
    return callee.property.value;
  }
  return null;
}

function isPotentiallyRenderableCallArgument(node) {
  return ![
    "ArrowFunctionExpression",
    "FunctionExpression",
    "ObjectExpression",
  ].includes(node.type);
}

function unwrapTransparentExpression(node) {
  let current = node;
  while (
    current &&
    [
      "ChainExpression",
      "TSAsExpression",
      "TSTypeAssertion",
      "TSNonNullExpression",
    ].includes(current.type)
  ) {
    current = current.expression;
  }
  return current;
}

function callbackReturnExpressions(callback) {
  if (
    callback?.type !== "ArrowFunctionExpression" &&
    callback?.type !== "FunctionExpression"
  ) {
    return [];
  }
  if (callback.body.type !== "BlockStatement") {
    return [callback.body];
  }

  const returns = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (
      node !== callback &&
      (node.type === "ArrowFunctionExpression" ||
        node.type === "FunctionExpression" ||
        node.type === "FunctionDeclaration")
    ) {
      return;
    }
    if (node.type === "ReturnStatement") {
      if (node.argument) returns.push(node.argument);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "parent" || key === "loc" || key === "range") continue;
      if (Array.isArray(value)) {
        value.forEach(visit);
      } else {
        visit(value);
      }
    }
  };
  visit(callback.body);
  return returns;
}

function mappedCallbackPreservesValues(callback) {
  if (callback?.type === "Identifier") return callback.name === "String";
  if (
    callback?.type !== "ArrowFunctionExpression" &&
    callback?.type !== "FunctionExpression"
  ) {
    return false;
  }
  const firstParameter = callback.params[0];
  if (firstParameter?.type !== "Identifier") return false;
  let body = callback.body;
  if (body.type === "BlockStatement") {
    if (
      body.body.length !== 1 ||
      body.body[0]?.type !== "ReturnStatement" ||
      !body.body[0].argument
    ) {
      return false;
    }
    body = body.body[0].argument;
  }
  const expression = unwrapTransparentExpression(body);
  if (
    expression?.type === "Identifier" &&
    expression.name === firstParameter.name
  ) {
    return true;
  }
  if (
    expression?.type === "CallExpression" &&
    expression.callee.type === "Identifier" &&
    expression.callee.name === "String" &&
    expression.arguments[0]?.type === "Identifier" &&
    expression.arguments[0].name === firstParameter.name
  ) {
    return true;
  }
  if (
    expression?.type === "TemplateLiteral" &&
    expression.expressions.length === 1 &&
    expression.quasis.every(
      (quasi) => (quasi.value.cooked ?? quasi.value.raw) === "",
    ) &&
    expression.expressions[0]?.type === "Identifier" &&
    expression.expressions[0].name === firstParameter.name
  ) {
    return true;
  }
  return (
    expression?.type === "CallExpression" &&
    expression.arguments.length === 0 &&
    expression.callee.type === "MemberExpression" &&
    !expression.callee.computed &&
    expression.callee.object.type === "Identifier" &&
    expression.callee.object.name === firstParameter.name &&
    expression.callee.property.type === "Identifier" &&
    ["toString", "valueOf"].includes(expression.callee.property.name)
  );
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
  if (node.type === "TemplateLiteral") {
    const translatedExpressions =
      node.expressions.filter(containsTranslatorCall);
    return (
      node.quasis.some((quasi) => quasi.value.raw.trim() !== "") ||
      node.expressions.some(
        (expression) => !containsTranslatorCall(expression),
      ) ||
      translatedExpressions.length > 1
    );
  }
  if (node.type === "ConditionalExpression") {
    return (
      isTranslatedComposition(node.consequent) ||
      isTranslatedComposition(node.alternate)
    );
  }
  if (node.type === "LogicalExpression") {
    return (
      isTranslatedComposition(node.left) ||
      isTranslatedComposition(node.right)
    );
  }
  if (
    node.type === "ChainExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSTypeAssertion" ||
    node.type === "TSNonNullExpression" ||
    node.type === "AwaitExpression"
  ) {
    return isTranslatedComposition(node.expression ?? node.argument);
  }
  if (node.type === "SequenceExpression") {
    return node.expressions.some(isTranslatedComposition);
  }
  if (node.type === "ArrayExpression") {
    const renderableElements = node.elements.filter(
      (element) =>
        element !== null &&
        element.type !== "SpreadElement" &&
        !(
          element.type === "Literal" &&
          (element.value === null || typeof element.value === "boolean")
        ),
    );
    return (
      renderableElements.some(isTranslatedComposition) ||
      (renderableElements.length > 1 &&
        renderableElements.some(containsTranslatorCall))
    );
  }
  if (node.type === "CallExpression" && !isTranslatorCall(node)) {
    const methodName = memberCallName(node);
    const renderableArguments = node.arguments.filter(
      (argument) =>
        argument.type !== "SpreadElement" &&
        isPotentiallyRenderableCallArgument(argument),
    );
    return (
      (node.callee.type === "MemberExpression" &&
        methodName !== null &&
        TRANSLATED_COMPOSITION_METHODS.has(methodName) &&
        containsTranslatorCall(node.callee.object)) ||
      (node.callee.type === "MemberExpression" &&
        methodName !== null &&
        COLLECTION_VALUE_PRESERVING_METHODS.has(methodName) &&
        isTranslatedComposition(node.callee.object)) ||
      (node.callee.type === "MemberExpression" &&
        methodName === "map" &&
        mappedCallbackPreservesValues(node.arguments[0]) &&
        isTranslatedComposition(node.callee.object)) ||
      (node.callee.type === "MemberExpression" &&
        methodName !== null &&
        RENDERED_COLLECTION_TRANSFORM_METHODS.has(methodName) &&
        callbackReturnExpressions(node.arguments[0]).some(
          isTranslatedComposition,
        )) ||
      (renderableArguments.length > 1 &&
        renderableArguments.some(containsTranslatorCall)) ||
      node.arguments.some(
        (argument) =>
          argument.type !== "SpreadElement" &&
          isTranslatedComposition(argument),
      )
    );
  }
  return false;
}

function separatorDelimitedChildGroups(children) {
  const groups = [[]];
  for (const child of children) {
    if (
      !isTranslatedChild(child) &&
      containsIndependentSeparator(child)
    ) {
      groups.push([]);
      continue;
    }
    groups[groups.length - 1].push(child);
  }
  return groups;
}

function layoutContainerTextRuns(children) {
  const groups = [[]];
  for (const child of children) {
    if (
      child.type === "JSXElement" ||
      (child.type === "JSXExpressionContainer" &&
        containsJsx(child.expression))
    ) {
      groups.push([]);
      continue;
    }
    groups[groups.length - 1].push(child);
  }
  return groups;
}

function translatedFragmentsInGroup(children) {
  const translatedChildren = children.filter(isTranslatedChild);
  if (translatedChildren.length === 0) return [];
  const composedChildren = translatedChildren.filter(
    (child) =>
      child.type === "JSXExpressionContainer" &&
      isTranslatedComposition(child.expression),
  );
  const hasAnotherTextPart = children.some(
    (child) =>
      !translatedChildren.includes(child) && isTextualSibling(child),
  );
  if (
    composedChildren.length === 0 &&
    !hasAnotherTextPart &&
    translatedChildren.length === 1
  ) {
    return [];
  }
  return translatedChildren;
}

function fragmentTranslatedFragmentsInGroup(children) {
  const isUnambiguouslyInlineElement = (child) =>
    isFormattingInlineElement(child) &&
    jsxElementName(child.openingElement) !== "Text";
  const translatedChildren = children.filter(
    (child) =>
      (child.type === "JSXExpressionContainer" &&
        !containsJsx(child.expression) &&
        containsTranslatorCall(child.expression)) ||
      containsTranslatorInInlineJsx(child),
  );
  if (translatedChildren.length === 0) return [];
  const composedChildren = translatedChildren.filter(
    (child) =>
      child.type === "JSXExpressionContainer" &&
      isTranslatedComposition(child.expression),
  );
  const hasAnotherDirectTextPart = children.some(
    (child) =>
      !translatedChildren.includes(child) &&
      isTextualSibling(child) &&
      (child.type !== "JSXElement" ||
        isUnambiguouslyInlineElement(child)),
  );
  const directTranslatedChildren = translatedChildren.filter(
    (child) => child.type === "JSXExpressionContainer",
  );
  const translatedInlineChildren = translatedChildren.filter(
    isUnambiguouslyInlineElement,
  );
  // A fragment may group independent formatted elements (especially sibling
  // React Native <Text> blocks), so nested translated elements alone are not
  // enough to prove one sentence is being assembled. They do become
  // fragments when combined with another rendered text part, while multiple
  // direct translated expressions retain the existing fragment behavior.
  if (
    composedChildren.length === 0 &&
    !hasAnotherDirectTextPart &&
    directTranslatedChildren.length +
      translatedInlineChildren.length <=
      1
  ) {
    return [];
  }
  return translatedChildren;
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
    const reportTranslatedFragments = (
      children,
      fragmentsInGroup = translatedFragmentsInGroup,
    ) => {
      // Compact metric/status rows may contain independent atoms separated
      // by a middle dot, bullet, or em dash. Validate each atom on its own
      // so a separator cannot hide grammatical fragments on either side.
      const fragments = separatorDelimitedChildGroups(children).flatMap(
        fragmentsInGroup,
      );
      for (const child of fragments) {
        context.report({ node: child, messageId: "fragment" });
      }
    };

    return {
      JSXElement(node) {
        if (
          !TEXT_CONTAINER_ELEMENTS.has(
            jsxElementName(node.openingElement),
          )
        ) {
          return;
        }
        const textRuns = hasLayoutDisplayClass(node)
          ? layoutContainerTextRuns(node.children)
          : [node.children];
        textRuns.forEach((children) =>
          reportTranslatedFragments(children),
        );
      },
      JSXFragment(node) {
        // A fragment commonly groups independent React Native `<Text>` blocks.
        // Inspect inline formatting recursively when it participates in a
        // larger text run, while leaving independent named blocks to their own
        // JSXElement visits.
        reportTranslatedFragments(
          node.children,
          fragmentTranslatedFragmentsInGroup,
        );
      },
      JSXAttribute(node) {
        if (
          !isTextualJsxAttribute(node) ||
          node.value?.type !== "JSXExpressionContainer" ||
          !isTranslatedComposition(node.value.expression)
        ) {
          return;
        }
        context.report({ node: node.value, messageId: "fragment" });
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
    const isKnownNumericDisplayCall = (node) => {
      if (isTranslatorCall(node)) {
        return !translatorKeyHasUnformattedNumericLiteral(node);
      }
      const callee = node.callee;
      if (
        callee.type === "Identifier" &&
        STANDALONE_REGIONAL_NUMERIC_FORMATTERS.has(callee.name)
      ) {
        return true;
      }
      if (callee.type !== "MemberExpression" || callee.computed) return false;
      if (
        callee.object.type === "Identifier" &&
        ["format", "formatter", "formatters"].includes(callee.object.name) &&
        callee.property.type === "Identifier" &&
        REGIONAL_FORMATTER_METHODS.has(callee.property.name)
      ) {
        return true;
      }
      if (
        callee.object.type === "CallExpression" &&
        callee.object.callee.type === "Identifier" &&
        callee.object.callee.name === "getFormatters" &&
        callee.property.type === "Identifier" &&
        REGIONAL_FORMATTER_METHODS.has(callee.property.name)
      ) {
        return true;
      }
      return false;
    };

    const containsUnformattedNumericLiteral = (node) => {
      if (!node || node.type === "JSXEmptyExpression") return false;
      if (node.type === "Literal") {
        return (
          typeof node.value === "number" ||
          typeof node.value === "bigint" ||
          (typeof node.value === "string" && /\d/.test(node.value))
        );
      }
      if (
        node.type === "UnaryExpression" &&
        (node.operator === "+" || node.operator === "-")
      ) {
        return containsUnformattedNumericLiteral(node.argument);
      }
      if (node.type === "ConditionalExpression") {
        return (
          containsUnformattedNumericLiteral(node.consequent) ||
          containsUnformattedNumericLiteral(node.alternate)
        );
      }
      if (node.type === "LogicalExpression") {
        // For `condition && value`, only the right-hand value is the intended
        // rendered branch; literals inside the boolean condition are not
        // display output. Fallback operators can render either side.
        return node.operator === "&&"
          ? containsUnformattedNumericLiteral(node.right)
          : containsUnformattedNumericLiteral(node.left) ||
              containsUnformattedNumericLiteral(node.right);
      }
      if (node.type === "BinaryExpression") {
        if (
          [
            "==",
            "!=",
            "===",
            "!==",
            "<",
            "<=",
            ">",
            ">=",
            "in",
            "instanceof",
          ].includes(node.operator)
        ) {
          return false;
        }
        return (
          containsUnformattedNumericLiteral(node.left) ||
          containsUnformattedNumericLiteral(node.right)
        );
      }
      if (node.type === "SequenceExpression") {
        return node.expressions.some(containsUnformattedNumericLiteral);
      }
      if (node.type === "ArrayExpression") {
        return node.elements.some(containsUnformattedNumericLiteral);
      }
      if (node.type === "TemplateLiteral") {
        return (
          node.quasis.some((quasi) =>
            /\d/.test(quasi.value.cooked ?? quasi.value.raw),
          ) ||
          node.expressions.some(containsUnformattedNumericLiteral)
        );
      }
      if (
        node.type === "ChainExpression" ||
        node.type === "TSAsExpression" ||
        node.type === "TSTypeAssertion" ||
        node.type === "TSNonNullExpression"
      ) {
        return containsUnformattedNumericLiteral(node.expression);
      }
      if (node.type === "CallExpression") {
        if (isKnownNumericDisplayCall(node)) return false;
        const methodName = memberCallName(node);
        return (
          (node.callee.type === "MemberExpression" &&
            methodName !== null &&
            RENDERED_COLLECTION_TRANSFORM_METHODS.has(methodName) &&
            callbackReturnExpressions(node.arguments[0]).some(
              containsUnformattedNumericLiteral,
            )) ||
          (node.callee.type === "MemberExpression" &&
            methodName !== null &&
            (NUMERIC_RECEIVER_DISPLAY_METHODS.has(methodName) ||
              COLLECTION_VALUE_PRESERVING_METHODS.has(methodName)) &&
            containsUnformattedNumericLiteral(node.callee.object)) ||
          node.arguments.some(
            (argument) =>
              argument.type !== "SpreadElement" &&
              containsUnformattedNumericLiteral(argument),
          )
        );
      }
      return false;
    };

    return {
      JSXText(node) {
        if (/\d/.test(node.value)) {
          context.report({ node, messageId: "numeric" });
        }
      },
      JSXExpressionContainer(node) {
        if (
          node.parent?.type !== "JSXElement" &&
          node.parent?.type !== "JSXFragment" &&
          !isTextualJsxAttribute(node.parent)
        ) {
          return;
        }
        if (containsUnformattedNumericLiteral(node.expression)) {
          context.report({ node, messageId: "numeric" });
        }
      },
      JSXAttribute(node) {
        if (
          isTextualJsxAttribute(node) &&
          node.value?.type === "Literal" &&
          typeof node.value.value === "string" &&
          /\d/.test(node.value.value)
        ) {
          context.report({ node: node.value, messageId: "numeric" });
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
        "Rider-facing search and matching must use normalizeForLocaleSearch() with the active locale, not unqualified case conversion.",
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
          !SEARCH_CASE_METHODS.has(node.callee.property.name)
        ) {
          return;
        }
        // Deliberately reject every unqualified case conversion in app
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
