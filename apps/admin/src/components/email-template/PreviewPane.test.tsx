import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PreviewPane } from "./PreviewPane.js";

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
});
