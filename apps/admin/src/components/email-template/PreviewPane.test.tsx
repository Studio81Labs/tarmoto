import { describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { PreviewPane } from "./PreviewPane.js";

type Res = { subject: string; html: string; text: string };

const mutate = vi.fn();
vi.mock("../../data/useAdminEmailTemplates.js", () => ({
  usePreview: () => ({ mutate, isPending: false }),
}));

describe("PreviewPane", () => {
  it("renders the returned html + subject after Preview", async () => {
    mutate.mockImplementation((_vars, { onSuccess }) =>
      onSuccess({ subject: "Hi Riku", html: "<p>hello</p>", text: "hello" }),
    );
    render(
      <PreviewPane
        tag="weekly-digest"
        locale="en"
        subject="Hi {displayName}"
        blocks={[]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /preview/i }));
    await waitFor(() =>
      expect(screen.getByText("Hi Riku")).toBeInTheDocument(),
    );
    expect(screen.getByTitle(/email preview/i)).toBeInTheDocument(); // the iframe
  });

  it("joins a field-level validation error array into one readable message", async () => {
    mutate.mockImplementation((_vars, { onError }) =>
      onError({
        message: ["subject: required", "block 1 (button): missing label"],
      }),
    );
    render(
      <PreviewPane tag="weekly-digest" locale="en" subject="" blocks={[]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /preview/i }));
    await waitFor(() =>
      expect(
        screen.getByText("subject: required; block 1 (button): missing label"),
      ).toBeInTheDocument(),
    );
  });

  it("ignores a preview response that resolves after the doc was edited", () => {
    let captured: ((res: Res) => void) | undefined;
    mutate.mockImplementation(
      (_vars: unknown, opts: { onSuccess: (r: Res) => void }) => {
        captured = opts.onSuccess; // in flight — don't resolve yet
      },
    );
    const { rerender } = render(
      <PreviewPane tag="weekly-digest" locale="en" subject="A" blocks={[]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /preview/i }));
    // Admin keeps editing before the POST resolves → the doc changes.
    rerender(
      <PreviewPane tag="weekly-digest" locale="en" subject="B" blocks={[]} />,
    );
    // The stale response (for subject "A") resolves now.
    act(() =>
      captured?.({ subject: "Rendered for A", html: "<p>a</p>", text: "a" }),
    );
    // It must be ignored — the editor doc is now "B".
    expect(screen.queryByText("Rendered for A")).not.toBeInTheDocument();
  });

  it("clears a shown preview once the doc changes", async () => {
    mutate.mockImplementation(
      (_vars: unknown, opts: { onSuccess: (r: Res) => void }) =>
        opts.onSuccess({
          subject: "Rendered for A",
          html: "<p>a</p>",
          text: "a",
        }),
    );
    const { rerender } = render(
      <PreviewPane tag="weekly-digest" locale="en" subject="A" blocks={[]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /preview/i }));
    expect(screen.getByText("Rendered for A")).toBeInTheDocument();
    // Edit → the shown preview is now stale → dropped.
    rerender(
      <PreviewPane tag="weekly-digest" locale="en" subject="B" blocks={[]} />,
    );
    await waitFor(() =>
      expect(screen.queryByText("Rendered for A")).not.toBeInTheDocument(),
    );
  });
});
