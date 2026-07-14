import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmailTemplatesScreen } from "./EmailTemplatesScreen.js";

vi.mock("../data/useAdminEmailTemplates.js", () => ({
  useEmailTemplates: () => ({
    data: [
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
    ],
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
  beforeEach(() => navigate.mockReset());
  it("lists templates with Live/Draft status and a legal badge", () => {
    render(<EmailTemplatesScreen />);
    expect(screen.getByText("Weekly digest")).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText(/legal/i)).toBeInTheDocument();
  });
});
