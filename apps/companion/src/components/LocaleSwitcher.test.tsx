import { render } from "@testing-library/react";
import { I18nProvider } from "@/i18n/I18nProvider";
import { LocaleSwitcher } from "./LocaleSwitcher";

describe("LocaleSwitcher", () => {
  it("renders nothing while only one locale is registered", () => {
    // With the single-locale registry the switcher is intentionally hidden so
    // the settings page stays clean. Once a second locale is added to
    // `src/i18n/locales/index.ts` this short-circuit no longer fires.
    const { container } = render(
      <I18nProvider locale="en">
        <LocaleSwitcher />
      </I18nProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
