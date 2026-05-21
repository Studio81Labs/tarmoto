import { render, screen } from "@testing-library/react";
import SettingsHubPage from "./page";

// The hub hard-codes hrefs for six top-level settings surfaces. A
// typo or accidental removal here would silently break navigation
// to entire areas (subscription billing, privacy controls, the data
// export / account deletion flow). These tests pin the contract so a
// missing or wrong-target link gets flagged by CI before it ships.
describe("SettingsHubPage", () => {
  it("renders one card link per settings section with the expected target", () => {
    render(<SettingsHubPage />);

    const expected: Array<{ label: string; href: string }> = [
      { label: "Profile", href: "/settings/profile" },
      { label: "Subscription", href: "/settings/subscription" },
      { label: "Privacy", href: "/settings/privacy" },
      { label: "My Bikes", href: "/settings/bikes" },
      { label: "Notifications", href: "/settings/notifications" },
      { label: "Data & Account", href: "/settings/data" },
    ];

    for (const { label, href } of expected) {
      const link = screen.getByRole("link", { name: new RegExp(label, "i") });
      expect(link).toHaveAttribute("href", href);
    }
  });

  it("renders exactly six section links — no orphan extras", () => {
    render(<SettingsHubPage />);
    // The hub itself is wrapped in a <Link>, so we count only those
    // pointing inside /settings/* — keeps the assertion robust against
    // any future ambient nav that might land in the same tree.
    const links = screen
      .getAllByRole("link")
      .filter((el) => el.getAttribute("href")?.startsWith("/settings/"));
    expect(links).toHaveLength(6);
  });
});
