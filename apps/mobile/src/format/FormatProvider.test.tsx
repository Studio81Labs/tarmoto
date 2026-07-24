import React from "react";
import { Text } from "react-native";
import { render } from "@testing-library/react-native";
import { FormatProvider } from "./FormatProvider";
import { getFormatters, setActiveFormatContext } from ".";
import { I18nProvider } from "@/i18n/I18nProvider";
import { getActiveLocale, setActiveLocale, type SupportedLocale } from "@/i18n";

function SuspendForever(): React.JSX.Element {
  throw new Promise<never>(() => {});
}

describe("FormatProvider", () => {
  beforeEach(() => {
    setActiveFormatContext({ locale: "en", timeZone: "UTC", units: "metric" });
  });

  it("publishes the formatter after the provider commits", async () => {
    await render(
      <FormatProvider locale="ar-EG" timeZone="Africa/Cairo" units="imperial">
        <Text>committed</Text>
      </FormatProvider>,
    );

    expect(getFormatters().locale).toBe("ar-EG");
    expect(getFormatters().timeZone).toBe("Africa/Cairo");
    expect(getFormatters().units).toBe("imperial");
  });

  it("does not publish formatter state from a suspended render", async () => {
    await render(
      <React.Suspense fallback={<Text>fallback</Text>}>
        <FormatProvider locale="ar-EG" timeZone="Africa/Cairo" units="imperial">
          <SuspendForever />
        </FormatProvider>
      </React.Suspense>,
    );

    expect(getFormatters().locale).toBe("en");
    expect(getFormatters().timeZone).toBe("UTC");
    expect(getFormatters().units).toBe("metric");
  });
});

describe("I18nProvider", () => {
  beforeEach(() => {
    setActiveLocale("en");
  });

  afterEach(() => {
    setActiveLocale("en");
  });

  it("does not publish locale state from a suspended render", async () => {
    // Production intentionally has one catalog today. Seed a second internal
    // value so the assertion can distinguish render-time publication from the
    // commit-safe effect without exposing an unsupported locale to app code.
    setActiveLocale("test-locale" as SupportedLocale);

    await render(
      <React.Suspense fallback={<Text>fallback</Text>}>
        <I18nProvider locale="en">
          <SuspendForever />
        </I18nProvider>
      </React.Suspense>,
    );

    expect(getActiveLocale() as string).toBe("test-locale");
  });
});
