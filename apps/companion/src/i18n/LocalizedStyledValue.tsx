import { Fragment } from "react";
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
  const messageParts = taggedMessage.split(STYLED_VALUE_TOKEN);
  if (messageParts.length === 1) {
    return (
      <>
        {t(messageKey, {
          ...values,
          [valueName]: formattedValue,
        })}
      </>
    );
  }

  return (
    <>
      {messageParts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 &&
            (as === "b" ? (
              <b className={className}>{formattedValue}</b>
            ) : (
              <span className={className}>{formattedValue}</span>
            ))}
          {part}
        </Fragment>
      ))}
    </>
  );
}
