import { render, screen } from "@testing-library/react";
import { ErrorState } from "../ErrorState";

test("renders code, label, title, body, actions, and footnote", () => {
  render(
    <ErrorState
      kind="not-found"
      code="404"
      label="Not found"
      title="This road isn't on the map"
      body="The route or page you're after has moved, ended, or never existed."
      actions={<a href="/">Back to home</a>}
      footnote="Last synced 2 min ago"
    />,
  );
  expect(screen.getByText("404")).toBeInTheDocument();
  expect(screen.getByText("Not found")).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: /this road isn't on the map/i }),
  ).toBeInTheDocument();
  expect(screen.getByText(/never existed/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Back to home" })).toBeVisible();
  expect(screen.getByText("Last synced 2 min ago")).toBeInTheDocument();
});

test("omits the action and footnote rows when not provided", () => {
  const { container } = render(
    <ErrorState
      kind="maintenance"
      code="503"
      label="Maintenance"
      title="Resurfacing in progress"
      body="Back shortly."
    />,
  );
  expect(container.querySelectorAll("a, button")).toHaveLength(0);
});

test("backdrop is decorative — hidden from assistive tech", () => {
  const { container } = render(
    <ErrorState
      kind="server"
      code="500"
      label="Server error"
      title="Something skidded out"
      body="Try again."
    />,
  );
  // Both backdrop layers and every svg carry aria-hidden.
  for (const svg of container.querySelectorAll("svg")) {
    expect(svg).toHaveAttribute("aria-hidden", "true");
  }
});
