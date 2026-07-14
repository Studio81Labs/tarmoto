import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EmailTemplateEditor } from "./EmailTemplateEditor.js";

// `vi.hoisted` mirrors the `authState` pattern below: `templateState.data`
// needs to change identity *within* a test (to simulate a background
// refetch resolving with fresh server data), and a `vi.mock` factory can't
// close over a reassigned out-of-scope variable — only a stable, hoisted,
// mutable container.
const templateState = vi.hoisted(() => {
  const initial = {
    tag: "weekly-digest",
    locale: "en",
    subject: "Hi {displayName}",
    blocks: [{ type: "paragraph", text: "hello" }],
    status: "none",
    version: 0,
    whitelist: { textVars: ["displayName"], urlVars: ["exploreUrl"] },
  };
  return { data: initial, initial };
});
const saveMutate = vi.fn();
const publishMutate = vi.fn();
vi.mock("../data/useAdminEmailTemplates.js", () => ({
  useEmailTemplate: () => ({
    data: templateState.data,
    isPending: false,
    error: null,
    refetch: vi.fn(),
  }),
  useSaveDraft: () => ({ mutate: saveMutate, isPending: false }),
  useTestSend: () => ({ mutate: vi.fn(), isPending: false }),
  usePublish: () => ({ mutate: publishMutate, isPending: false }),
  useReset: () => ({ mutate: vi.fn(), isPending: false }),
  usePreview: () => ({ mutate: vi.fn(), isPending: false }),
}));

// Vitest rejects a `vi.mock` factory that closes over an out-of-scope `let` —
// "The module factory is not allowed to reference any out-of-scope
// variables." `vi.hoisted` creates the mutable state before the mocks are
// installed, so the factory below can read it without violating that rule.
const authState = vi.hoisted(() => ({ role: "support" as string }));
vi.mock("../auth/useAdminAuth.js", () => ({
  useAdminAuth: () => ({ user: { role: authState.role } }),
}));

describe("EmailTemplateEditor", () => {
  beforeEach(() => {
    saveMutate.mockReset();
    publishMutate.mockReset();
    templateState.data = templateState.initial;
  });

  it("hides Publish/Reset for support and shows Save draft", () => {
    authState.role = "support";
    render(
      <EmailTemplateEditor tag="weekly-digest" locale="en" onBack={vi.fn()} />,
    );
    expect(
      screen.getByRole("button", { name: /save draft/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^publish$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^reset$/i }),
    ).not.toBeInTheDocument();
  });

  it("shows Publish for super_admin and confirms before publishing", async () => {
    authState.role = "super_admin";
    render(
      <EmailTemplateEditor tag="weekly-digest" locale="en" onBack={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^publish$/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /publish now/i }),
    );
    await waitFor(() => expect(publishMutate).toHaveBeenCalled());
  });

  it("saves the draft with the edited body", () => {
    authState.role = "support";
    render(
      <EmailTemplateEditor tag="weekly-digest" locale="en" onBack={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /save draft/i }));
    expect(saveMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { path: { tag: "weekly-digest", locale: "en" } },
        body: expect.objectContaining({ subject: "Hi {displayName}" }),
      }),
      expect.anything(),
    );
  });

  it("does not clobber an in-progress edit when a background refetch resolves with fresh data for the same template", () => {
    authState.role = "support";
    const { rerender } = render(
      <EmailTemplateEditor tag="weekly-digest" locale="en" onBack={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText(/subject/i), {
      target: { value: "Edited while a refetch is in flight" },
    });
    expect(screen.getByLabelText(/subject/i)).toHaveValue(
      "Edited while a refetch is in flight",
    );

    // Simulate the background GET that Save/Publish fire off (`void refetch()`)
    // resolving with fresh server data for the SAME (tag, locale) — a new
    // `data` object, e.g. with a bumped version. The seed effect must
    // recognize this (tag, locale) was already seeded and leave the
    // in-progress edit alone instead of reverting it.
    templateState.data = {
      ...templateState.data,
      subject: "Subject from the server",
      version: 1,
    };
    rerender(
      <EmailTemplateEditor tag="weekly-digest" locale="en" onBack={vi.fn()} />,
    );

    expect(screen.getByLabelText(/subject/i)).toHaveValue(
      "Edited while a refetch is in flight",
    );
  });
});
