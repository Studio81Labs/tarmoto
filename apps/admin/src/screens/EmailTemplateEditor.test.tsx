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
const resetMutate = vi.fn();
const invalidateQueriesMock = vi.fn();
// The component calls the real `useQueryClient` (not the mocked
// useAdminEmailTemplates data layer below) to invalidate the templates LIST
// query on Save/Publish/Reset success. Nothing else rendered by this test
// (BlockCard/VarChips/PreviewPane/Dialog/@tarmoto/ui) touches
// @tanstack/react-query, so mocking just `useQueryClient` here is safe.
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
}));
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
  useReset: () => ({ mutate: resetMutate, isPending: false }),
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
    resetMutate.mockReset();
    invalidateQueriesMock.mockReset();
    templateState.data = templateState.initial;
    // Several tests below drive window.location.hash directly to exercise
    // the hashchange dirty-guard; reset it so no test starts from whatever
    // a previous one left behind.
    window.location.hash = "";
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

  it("invalidates the templates list query when a save succeeds, so the list's status pill refreshes", () => {
    authState.role = "support";
    render(
      <EmailTemplateEditor tag="weekly-digest" locale="en" onBack={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /save draft/i }));
    expect(saveMutate).toHaveBeenCalled();

    // `saveMutate` is a bare spy — it never runs the mutation lifecycle on
    // its own, so drive the `onSuccess` callback the component passed in,
    // the same way the real mutation would once the request resolves.
    const options = saveMutate.mock.calls[0]?.[1] as {
      onSuccess: () => void;
    };
    expect(invalidateQueriesMock).not.toHaveBeenCalled();
    options.onSuccess();

    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ["get", "/admin/email/templates"],
    });
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

  it("re-seeds the editor from the default doc after Reset succeeds, instead of keeping the deleted override body", async () => {
    authState.role = "super_admin";
    const { rerender } = render(
      <EmailTemplateEditor tag="weekly-digest" locale="en" onBack={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^reset$/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /remove override/i }),
    );
    expect(resetMutate).toHaveBeenCalledTimes(1);

    // `resetMutate` is a bare spy — drive the `onSuccess` the component
    // passed in, the same way the real mutation would once the DELETE
    // resolves.
    const options = resetMutate.mock.calls[0]?.[1] as {
      onSuccess: () => void;
    };
    options.onSuccess();

    // The override is gone server-side; the background refetch
    // (`void refetch()`) would resolve with the DEFAULT doc for this
    // (tag, locale) — a new `data` identity. Simulate that resolving.
    templateState.data = {
      ...templateState.initial,
      subject: "Default subject from code",
      blocks: [{ type: "paragraph", text: "default body" }],
      status: "none",
      version: 0,
    };
    rerender(
      <EmailTemplateEditor tag="weekly-digest" locale="en" onBack={vi.fn()} />,
    );

    // Seed-once must not suppress this re-seed: Reset clears `seededKey`
    // specifically so the deleted override body doesn't linger in the editor.
    expect(screen.getByLabelText(/subject/i)).toHaveValue(
      "Default subject from code",
    );
  });

  it("keeps the dirty guard if the admin edits again before an in-flight save resolves", () => {
    authState.role = "support";
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    window.location.hash = "#/email-templates/weekly-digest/en";

    render(
      <EmailTemplateEditor tag="weekly-digest" locale="en" onBack={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText(/subject/i), {
      target: { value: "First edit" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save draft/i }));
    expect(saveMutate).toHaveBeenCalledTimes(1);

    // `saveMutate` is a bare spy — capture the `onSuccess` the component
    // passed in for THIS (now-stale) submission.
    const options = saveMutate.mock.calls[0]?.[1] as {
      onSuccess: () => void;
    };

    // The admin keeps typing before the in-flight PUT resolves.
    fireEvent.change(screen.getByLabelText(/subject/i), {
      target: { value: "Second edit, made while the save was in flight" },
    });

    // The save now resolves for the FIRST snapshot — it must not clear
    // dirty, because local state has since diverged from what was saved.
    options.onSuccess();

    // Prove `dirty` is still true via the hashchange guard — the confirm
    // that used to live in handleBack moved here (see the tests below), and
    // it only ever prompts while dirty.
    window.location.hash = "#/users";
    window.dispatchEvent(new Event("hashchange"));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe("#/email-templates/weekly-digest/en");

    confirmSpy.mockRestore();
  });

  it("handleBack calls onBack directly without confirming — the hashchange guard owns the prompt now", () => {
    authState.role = "support";
    const onBack = vi.fn();
    // Should never be invoked by this path; mocked defensively so a jsdom
    // "not implemented" error can't masquerade as an assertion failure.
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(
      <EmailTemplateEditor tag="weekly-digest" locale="en" onBack={onBack} />,
    );

    fireEvent.change(screen.getByLabelText(/subject/i), {
      target: { value: "Edited" },
    });
    fireEvent.click(screen.getByRole("button", { name: /templates/i }));

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it("hashchange guard prompts and reverts the hash when the admin cancels leaving while dirty", () => {
    authState.role = "support";
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    window.location.hash = "#/email-templates/weekly-digest/en";

    render(
      <EmailTemplateEditor tag="weekly-digest" locale="en" onBack={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText(/subject/i), {
      target: { value: "Edited" },
    });
    const editorHash = window.location.hash;

    // A sidebar route click or the browser Back button changes the hash
    // directly — simulate that with a manual hashchange dispatch, the same
    // way `routes.test.ts` drives window.location.hash for useHashRoute.
    window.location.hash = "#/users";
    window.dispatchEvent(new Event("hashchange"));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe(editorHash);

    confirmSpy.mockRestore();
  });

  it("hashchange guard allows the navigation when the admin confirms leaving while dirty", () => {
    authState.role = "support";
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    window.location.hash = "#/email-templates/weekly-digest/en";

    render(
      <EmailTemplateEditor tag="weekly-digest" locale="en" onBack={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText(/subject/i), {
      target: { value: "Edited" },
    });

    window.location.hash = "#/users";
    window.dispatchEvent(new Event("hashchange"));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe("#/users");

    confirmSpy.mockRestore();
  });
});
