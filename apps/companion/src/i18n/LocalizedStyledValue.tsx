import type { EnglishMessageKey, Translate, TranslationValues } from ".";

const STYLED_VALUE_TOKEN = "\uE000";

export function LocalizedStyledValue({
  t,
  messageKey,
  values,
  valueName,
  formattedValue,
  className,
  as = "span",
}: {
  t: Translate;
  messageKey: EnglishMessageKey;
  values?: TranslationValues;
  valueName: string;
  formattedValue: string;
  className: string;
  as?: "b" | "span";
}) {
  // Format the complete message before adding markup. The private-use token
  // gives the catalog full control over placeholder order and punctuation
  // without relying on the visible value being unique in the result.
  const taggedMessage = t(messageKey, {
    ...values,
    [valueName]: STYLED_VALUE_TOKEN,
  });
  const valueIndex = taggedMessage.indexOf(STYLED_VALUE_TOKEN);
  if (valueIndex < 0) {
    return (
      <>
        {t(messageKey, {
          ...values,
          [valueName]: formattedValue,
        })}
      </>
    );
  }
  const beforeValue = taggedMessage.slice(0, valueIndex);
  const afterValue = taggedMessage.slice(
    valueIndex + STYLED_VALUE_TOKEN.length,
  );
  const styledValue =
    as === "b" ? (
      <b className={className}>{formattedValue}</b>
    ) : (
      <span className={className}>{formattedValue}</span>
    );
  return (
    <>
      {beforeValue}
      {styledValue}
      {afterValue}
    </>
  );
}
