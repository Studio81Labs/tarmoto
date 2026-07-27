import React from "react";
import { Alert, Text } from "react-native";
import { render } from "@testing-library/react-native";

jest.mock(".", () => {
  const actual = jest.requireActual<typeof import(".")>(".");
  return {
    ...actual,
    LOCALES: {
      ...actual.LOCALES,
      ar: { label: "العربية", direction: "rtl" },
    },
    resolveLocale: (locale: string | null | undefined) =>
      locale === "ar" ? "ar" : actual.resolveLocale(locale),
    localeDirection: (locale: string) => (locale === "ar" ? "rtl" : "ltr"),
  };
});

jest.mock("./layoutDirection", () => ({
  isLayoutDirectionReady: jest.fn(() => true),
  syncLayoutDirection: jest.fn(),
}));

import { getActiveLocale, setActiveLocale, type SupportedLocale } from ".";
import { I18nProvider, useI18n } from "./I18nProvider";
import { syncLayoutDirection } from "./layoutDirection";

const syncLayoutDirectionMock = jest.mocked(syncLayoutDirection);

function LocaleConsumer() {
  return <Text testID="locale">{useI18n().locale}</Text>;
}
const MemoizedLocaleConsumer = React.memo(LocaleConsumer);

describe("I18nProvider layout direction changes", () => {
  beforeEach(() => {
    setActiveLocale("en");
    syncLayoutDirectionMock.mockReturnValue(true);
    jest.spyOn(Alert, "alert").mockImplementation(() => {});
  });

  afterEach(() => {
    setActiveLocale("en");
    jest.restoreAllMocks();
  });

  it("updates context-bound consumers across a memo boundary", async () => {
    const view = await render(
      <I18nProvider locale="en">
        <MemoizedLocaleConsumer />
      </I18nProvider>,
    );

    await view.rerender(
      <I18nProvider locale={"ar" as SupportedLocale}>
        <MemoizedLocaleConsumer />
      </I18nProvider>,
    );

    expect(view.getByTestId("locale").props.children).toBe("ar");
  });

  it("keeps the committed locale until an RTL direction change is applied after restart", async () => {
    const view = await render(
      <I18nProvider locale="en">
        <LocaleConsumer />
      </I18nProvider>,
    );

    syncLayoutDirectionMock.mockReturnValue(false);
    await view.rerender(
      <I18nProvider locale={"ar" as SupportedLocale}>
        <LocaleConsumer />
      </I18nProvider>,
    );

    expect(view.getByTestId("locale").props.children).toBe("en");
    expect(getActiveLocale()).toBe("en");
    expect(Alert.alert).toHaveBeenCalledWith(
      "Restart required",
      "Restart Tarmoto to apply the new language direction.",
    );

    view.unmount();
    syncLayoutDirectionMock.mockReturnValue(true);
    const restartedView = await render(
      <I18nProvider locale={"ar" as SupportedLocale}>
        <LocaleConsumer />
      </I18nProvider>,
    );

    expect(restartedView.getByTestId("locale").props.children).toBe("ar");
    expect(getActiveLocale() as string).toBe("ar");
  });
});
