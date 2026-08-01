import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./Sidebar.js";

const ROUTES = [
  { key: "overview", label: "Overview" },
  { key: "users", label: "Users" },
];

describe("Sidebar", () => {
  it("navigates to Overview when the brand block is clicked", async () => {
    const onNavigate = vi.fn();
    render(<Sidebar routes={ROUTES} active="users" onNavigate={onNavigate} />);

    await userEvent.click(
      screen.getByRole("button", { name: /admin console/i }),
    );

    expect(onNavigate).toHaveBeenCalledWith("overview");
  });

  it("navigates to the clicked nav item", async () => {
    const onNavigate = vi.fn();
    render(
      <Sidebar routes={ROUTES} active="overview" onNavigate={onNavigate} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Users" }));

    expect(onNavigate).toHaveBeenCalledWith("users");
  });

  it("marks the active route as the current page", () => {
    render(<Sidebar routes={ROUTES} active="users" onNavigate={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Users" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.getByRole("button", { name: "Overview" }),
    ).not.toHaveAttribute("aria-current");
  });
});
