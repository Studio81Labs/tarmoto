import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdministratorsScreen } from "./AdministratorsScreen.js";

const mockPatchMutate = vi.fn();
const mockCreateMutate = vi.fn();
const mockRefetch = vi.fn();

const DEFAULT_ROWS = [
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
];

let mockAdminData = DEFAULT_ROWS;

vi.mock("../data/useAdminAdmins.js", () => ({
  useAdminAdminsList: () => ({
    data: mockAdminData,
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
    mockAdminData = [...DEFAULT_ROWS];
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

  it("shows per-row controls for all manageable rows when super_admin", () => {
    render(
      <AdministratorsScreen
        currentRole="super_admin"
        currentAdminId="super1"
      />,
    );
    // a1 (admin) → Disable; a2 (support) → Enable; currentAdminId "super1" not in rows
    const disableButtons = screen.getAllByRole("button", {
      name: /disable|enable/i,
    });
    expect(disableButtons).toHaveLength(2);
  });

  it("shows manage controls for a peer super_admin row", () => {
    mockAdminData = [
      ...DEFAULT_ROWS,
      {
        id: "a3",
        email: "peer@tarmoto.app",
        role: "super_admin",
        status: "active",
        last_login_at: null,
        created_at: "2026-03-01T00:00:00Z",
      },
    ];
    render(
      // currentAdminId "super1" is NOT in the list → all three rows get controls
      <AdministratorsScreen
        currentRole="super_admin"
        currentAdminId="super1"
      />,
    );
    const buttons = screen.getAllByRole("button", { name: /disable|enable/i });
    // a1, a2, and peer a3 (super_admin) all receive controls
    expect(buttons).toHaveLength(3);
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

  it("role Select for a manageable row does not include admin/super_admin for a non-super_admin actor", () => {
    render(
      // admin actor can only manage a2 (support); a1 (admin peer) gets no controls
      <AdministratorsScreen currentRole="admin" currentAdminId="other" />,
    );
    // The per-row role Select for a2 should only expose roles the admin can assign
    const roleSelect = screen.getByRole("combobox", {
      name: /role for support@tarmoto\.app/i,
    });
    const options = within(roleSelect).getAllByRole("option");
    const values = options.map((o) => o.getAttribute("value"));
    expect(values).not.toContain("admin");
    expect(values).not.toContain("super_admin");
    expect(values).toContain("read_only");
    expect(values).toContain("support");
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

  it("shows a specific error for a 409 response from patch (not the generic fallback)", async () => {
    const user = userEvent.setup();
    render(
      <AdministratorsScreen
        currentRole="super_admin"
        currentAdminId="super1"
      />,
    );
    // a1 is active → Disable button (status mutation path)
    const disableBtn = screen.getByRole("button", { name: /disable/i });
    await user.click(disableBtn);

    expect(mockPatchMutate).toHaveBeenCalledOnce();
    const [, options] = mockPatchMutate.mock.calls[0] as [
      unknown,
      { onError: (err: unknown) => void },
    ];

    // Simulate the REAL shape thrown by openapi-react-query: the parsed Nest
    // error body ({ statusCode, message, error }) — NOT a Response object.
    // Wrap in act() because onError calls setPatchError (React state update).
    act(() => {
      options.onError({
        statusCode: 409,
        message:
          "Cannot make this change: it would remove the last super admin.",
        error: "Conflict",
      });
    });

    // The server message should be surfaced verbatim, not the generic fallback.
    expect(screen.getByText(/last super admin/i)).toBeInTheDocument();
    expect(
      screen.queryByText("Failed to update status."),
    ).not.toBeInTheDocument();
  });

  it("shows a specific error for a 403 response from patch (not the generic fallback)", async () => {
    const user = userEvent.setup();
    render(
      <AdministratorsScreen
        currentRole="super_admin"
        currentAdminId="super1"
      />,
    );
    const disableBtn = screen.getByRole("button", { name: /disable/i });
    await user.click(disableBtn);

    const [, options] = mockPatchMutate.mock.calls[0] as [
      unknown,
      { onError: (err: unknown) => void },
    ];

    // Simulate the REAL shape thrown by openapi-react-query.
    act(() => {
      options.onError({
        statusCode: 403,
        message:
          "Permission denied: you don't have permission to make this change.",
        error: "Forbidden",
      });
    });

    expect(screen.getByText(/permission denied/i)).toBeInTheDocument();
    expect(
      screen.queryByText("Failed to update status."),
    ).not.toBeInTheDocument();
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
