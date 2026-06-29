import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureFlagsScreen } from "./FeatureFlagsScreen.js";

const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockRefetch = vi.fn();

vi.mock("../data/useAdminFlags.js", () => ({
  useAdminFlagsList: () => ({
    data: [
      {
        id: "f1",
        key: "group_rides",
        enabled: false,
        description: "Group ride tools",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ],
    isPending: false,
    error: null,
    refetch: mockRefetch,
  }),
  useCreateFlag: () => ({ mutate: mockCreate, isPending: false }),
  useUpdateFlag: () => ({ mutate: mockUpdate, isPending: false }),
  useDeleteFlag: () => ({ mutate: mockDelete, isPending: false }),
}));

describe("FeatureFlagsScreen", () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockUpdate.mockClear();
    mockDelete.mockClear();
    mockRefetch.mockClear();
  });

  it("renders the flag rows", () => {
    render(<FeatureFlagsScreen />);
    expect(screen.getByText("group_rides")).toBeInTheDocument();
  });

  it("toggling a flag calls update with the negated enabled", async () => {
    render(<FeatureFlagsScreen />);
    await userEvent.click(screen.getByRole("button", { name: /enable/i }));
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { path: { id: "f1" } },
        body: { enabled: true },
      }),
      expect.anything(),
    );
  });

  it("create dialog submits with correct body, refetches, closes, and resets fields on success", async () => {
    const user = userEvent.setup();
    render(<FeatureFlagsScreen />);

    // The form lives in a dialog opened from the header action.
    await user.click(screen.getByRole("button", { name: /new flag/i }));
    await user.type(
      screen.getByRole("textbox", { name: /key/i }),
      "new_feature",
    );
    await user.type(
      screen.getByRole("textbox", { name: /description/i }),
      "A new feature",
    );
    await user.click(screen.getByRole("button", { name: /create flag/i }));

    expect(mockCreate).toHaveBeenCalledWith(
      {
        body: {
          key: "new_feature",
          enabled: false,
          description: "A new feature",
        },
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    // onSuccess refetches and closes the dialog (fields unmount).
    const [, { onSuccess }] = mockCreate.mock.calls[0] as [
      unknown,
      { onSuccess: () => void },
    ];
    act(() => {
      onSuccess();
    });
    expect(mockRefetch).toHaveBeenCalled();
    expect(
      screen.queryByRole("textbox", { name: /key/i }),
    ).not.toBeInTheDocument();

    // Re-opening shows the reset (empty) form.
    await user.click(screen.getByRole("button", { name: /new flag/i }));
    expect(
      (screen.getByRole("textbox", { name: /key/i }) as HTMLInputElement).value,
    ).toBe("");
    expect(
      (
        screen.getByRole("textbox", {
          name: /description/i,
        }) as HTMLInputElement
      ).value,
    ).toBe("");
  });

  it("delete calls mutate with the correct path param when confirm returns true", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<FeatureFlagsScreen />);
    await userEvent.click(screen.getByRole("button", { name: /delete/i }));
    expect(mockDelete).toHaveBeenCalledWith(
      { params: { path: { id: "f1" } } },
      expect.anything(),
    );
  });

  it("delete does NOT call mutate when confirm returns false", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<FeatureFlagsScreen />);
    await userEvent.click(screen.getByRole("button", { name: /delete/i }));
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
