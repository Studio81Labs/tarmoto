import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmailTemplatesScreen } from "./EmailTemplatesScreen.js";

type SummaryRow = {
  tag: string;
  label: string;
  hasDraft: boolean;
  hasPublished: boolean;
  legalSensitive: boolean;
};

// `vi.hoisted` mutable rows so a test can vary the list (a vi.mock factory
// can't close over a reassigned `let`).
const listState = vi.hoisted(() => {
  const initial: SummaryRow[] = [
    {
      tag: "weekly-digest",
      label: "Weekly digest",
      hasDraft: false,
      hasPublished: true,
      legalSensitive: false,
    },
    {
      tag: "account-deletion-scheduled",
      label: "Account deletion scheduled",
      hasDraft: true,
      hasPublished: false,
      legalSensitive: true,
    },
  ];
  return { rows: initial, initial };
});
vi.mock("../data/useAdminEmailTemplates.js", () => ({
  useEmailTemplates: () => ({
    data: listState.rows,
    isPending: false,
    error: null,
  }),
}));
const navigate = vi.fn();
vi.mock("../app/routes.js", () => ({
  useHashRoute: () => ({ active: "email-templates", params: [], navigate }),
  routes: [],
}));

describe("EmailTemplatesScreen (list)", () => {
  beforeEach(() => {
    navigate.mockReset();
    listState.rows = listState.initial;
  });

  it("lists templates with Live/Draft status and a legal badge", () => {
    render(<EmailTemplatesScreen />);
    expect(screen.getByText("Weekly digest")).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText(/legal/i)).toBeInTheDocument();
  });

  it("shows both Live and Draft when a template has a published override AND a pending draft", () => {
    listState.rows = [
      {
        tag: "weekly-digest",
        label: "Weekly digest",
        hasDraft: true,
        hasPublished: true,
        legalSensitive: false,
      },
    ];
    render(<EmailTemplatesScreen />);
    // Both surface so the pending draft isn't hidden behind "Live".
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
  });
});
