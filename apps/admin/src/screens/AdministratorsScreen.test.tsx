import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdministratorsScreen } from "./AdministratorsScreen.js";

const mockPatchMutate = vi.fn();
const mockCreateMutate = vi.fn();
const mockRefetch = vi.fn();

vi.mock("../data/useAdminAdmins.js", () => ({
  useAdminAdminsList: () => ({
    data: [
      {
        id: "a1",
        email: "ops@tarmoto.app",
        role: "admin",
        status: "active",
        last_login_at: null,
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "a2",
        email: "support@tarmoto.app",
        role: "support",
        status: "disabled",
        last_login_at: "2026-05-01T10:00:00Z",
        created_at: "2026-02-01T00:00:00Z",
      },
    ],
    isPending: false,
    error: null,
    refetch: mockRefetch,
  }),
  useCreateAdmin: () => ({ mutate: mockCreateMutate, isPending: false }),
  usePatchAdmin: () => ({ mutate: mockPatchMutate, isPending: false }),
}));

describe("AdministratorsScreen", () => {
  beforeEach(() => {
    mockPatchMutate.mockClear();
    mockCreateMutate.mockClear();
    mockRefetch.mockClear();
  });

  it("renders the admin roster", () => {
    render(
      <AdministratorsScreen
        currentRole="super_admin"
        currentAdminId="super1"
      />,
    );
    expect(screen.getByText("ops@tarmoto.app")).toBeInTheDocument();
    expect(screen.getAllByText(/admin/i).length).toBeGreaterThan(0);
  });

  it("renders the page header", () => {
    render(
      <AdministratorsScreen
        currentRole="super_admin"
        currentAdminId="super1"
      />,
    );
    expect(screen.getByText("Administrators")).toBeInTheDocument();
  });

  it("shows per-row controls for manageable rows when super_admin", () => {
    render(
      <AdministratorsScreen
        currentRole="super_admin"
        currentAdminId="super1"
      />,
    );
    // Both a1 (admin) and a2 (support) are manageable by super_admin
    const disableButtons = screen.getAllByRole("button", {
      name: /disable|enable/i,
    });
    expect(disableButtons.length).toBeGreaterThanOrEqual(1);
  });

  it("hides per-row controls for own row (self-lockout)", () => {
    render(
      // currentAdminId matches a1
      <AdministratorsScreen currentRole="super_admin" currentAdminId="a1" />,
    );
    // a1 row (ops@tarmoto.app) should not have an enable/disable button
    // a2 row (support@tarmoto.app) should still have one
    const rows = screen.getAllByRole("button", { name: /disable|enable/i });
    // Only a2 gets a button, not a1
    expect(rows).toHaveLength(1);
  });

  it("hides per-row controls for rows with same or higher rank when actor is admin", () => {
    render(
      // admin actor cannot manage the admin peer (a1) — only support (a2) is lower
      <AdministratorsScreen currentRole="admin" currentAdminId="other" />,
    );
    // a1 (admin) — same rank, no controls
    // a2 (support) — lower rank, controls shown
    const buttons = screen.getAllByRole("button", { name: /disable|enable/i });
    expect(buttons).toHaveLength(1);
  });

  it("calls patchMutate with correct body and refetches on success", async () => {
    const user = userEvent.setup();
    render(
      <AdministratorsScreen
        currentRole="super_admin"
        currentAdminId="super1"
      />,
    );
    // a1 is active → Disable button
    const disableBtn = screen.getByRole("button", { name: /disable/i });
    await user.click(disableBtn);

    expect(mockPatchMutate).toHaveBeenCalledOnce();
    const [body, options] = mockPatchMutate.mock.calls[0] as [
      unknown,
      { onSuccess: () => void },
    ];
    expect(body).toMatchObject({ params: { path: { id: "a1" } } });

    await options.onSuccess();
    expect(mockRefetch).toHaveBeenCalledOnce();
  });

  it("shows New Admin form", () => {
    render(
      <AdministratorsScreen
        currentRole="super_admin"
        currentAdminId="super1"
      />,
    );
    expect(
      screen.getByRole("button", { name: /add admin|create admin|new admin/i }),
    ).toBeInTheDocument();
  });
});
