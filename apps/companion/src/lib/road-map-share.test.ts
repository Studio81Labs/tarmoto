import { shareRoadMap } from "./road-map-share";
import { mapSharesApi } from "@/lib/api";
import { toast } from "@/lib/toast";

vi.mock("@/lib/api", () => ({
  mapSharesApi: {
    create: vi.fn(),
    revoke: vi.fn(),
  },
}));

vi.mock("@/lib/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

const createMock = vi.mocked(mapSharesApi.create);
const revokeMock = vi.mocked(mapSharesApi.revoke);
const successMock = vi.mocked(toast.success);
const errorMock = vi.mocked(toast.error);

const SNAPSHOT = { period: "all", segments: [] } as Record<string, unknown>;

function createdShare(
  overrides: Partial<{ id: string; share_url: string }> = {},
) {
  return {
    data: {
      id: overrides.id ?? "share-1",
      share_token: "tok-1",
      share_url: overrides.share_url ?? "/m/tok-1",
      title: "My Tarmoto road map",
      view_count: 0,
      created_at: "2026-06-24T00:00:00.000Z",
      updated_at: "2026-06-24T00:00:00.000Z",
    },
  };
}

/**
 * Replace `navigator` for the duration of a test. The helper only reads
 * `share`, `canShare`, and `clipboard`, so a partial stub is enough.
 */
function stubNavigator(nav: Partial<Navigator>) {
  vi.stubGlobal("navigator", nav);
}

describe("shareRoadMap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    revokeMock.mockResolvedValue({ data: undefined });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("copies the absolute share URL to the clipboard and toasts success when only the clipboard is available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ clipboard: { writeText } as unknown as Clipboard });
    createMock.mockResolvedValue(createdShare());

    await shareRoadMap("My Tarmoto road map", SNAPSHOT);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith({
      title: "My Tarmoto road map",
      snapshot: SNAPSHOT,
    });
    // share_url is relative; the helper resolves it against the page origin.
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/m/tok-1`);
    expect(successMock).toHaveBeenCalledWith("Link copied");
    expect(errorMock).not.toHaveBeenCalled();
    // Delivery succeeded — the row must NOT be rolled back.
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it("uses the native Web Share sheet without a toast when available", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn();
    stubNavigator({
      share,
      clipboard: { writeText } as unknown as Clipboard,
    });
    createMock.mockResolvedValue(createdShare());

    await shareRoadMap("My Tarmoto road map", SNAPSHOT);

    expect(share).toHaveBeenCalledTimes(1);
    // The native sheet is its own confirmation — no clipboard, no toast.
    expect(writeText).not.toHaveBeenCalled();
    expect(successMock).not.toHaveBeenCalled();
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it("rolls back the created share and toasts an error when the clipboard write fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    stubNavigator({ clipboard: { writeText } as unknown as Clipboard });
    createMock.mockResolvedValue(createdShare({ id: "share-9" }));

    await shareRoadMap("My Tarmoto road map", SNAPSHOT);

    expect(revokeMock).toHaveBeenCalledWith("share-9");
    expect(errorMock).toHaveBeenCalledWith("denied");
    expect(successMock).not.toHaveBeenCalled();
  });

  it("rolls back the created share but stays silent when the user cancels the Web Share sheet", async () => {
    const abort = new Error("cancelled");
    abort.name = "AbortError";
    const share = vi.fn().mockRejectedValue(abort);
    stubNavigator({
      share,
      clipboard: { writeText: vi.fn() } as unknown as Clipboard,
    });
    createMock.mockResolvedValue(createdShare({ id: "share-7" }));

    await shareRoadMap("My Tarmoto road map", SNAPSHOT);

    // Cancelled share still rolls back the row so it doesn't orphan...
    expect(revokeMock).toHaveBeenCalledWith("share-7");
    // ...but a deliberate cancel is not an error.
    expect(errorMock).not.toHaveBeenCalled();
  });

  it("toasts an error and never rolls back when the share row could not be created", async () => {
    const writeText = vi.fn();
    stubNavigator({ clipboard: { writeText } as unknown as Clipboard });
    createMock.mockRejectedValue(new Error("offline"));

    await shareRoadMap("My Tarmoto road map", SNAPSHOT);

    expect(errorMock).toHaveBeenCalledWith("offline");
    // No share id was ever assigned, so there's nothing to revoke.
    expect(revokeMock).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("bails before creating a share when neither Web Share nor the clipboard is available", async () => {
    stubNavigator({});

    await shareRoadMap("My Tarmoto road map", SNAPSHOT);

    expect(createMock).not.toHaveBeenCalled();
    expect(errorMock).toHaveBeenCalledWith(
      expect.stringContaining("doesn't support sharing"),
    );
  });

  it("guards against a duplicate row when canShare rejects the payload and the clipboard is absent", async () => {
    // Web Share present but `canShare` vetoes the payload, and there's no
    // clipboard fallback — the helper should roll the row back and error.
    const share = vi.fn();
    stubNavigator({
      share,
      canShare: vi.fn().mockReturnValue(false),
    });
    createMock.mockResolvedValue(createdShare({ id: "share-3" }));

    await shareRoadMap("My Tarmoto road map", SNAPSHOT);

    expect(share).not.toHaveBeenCalled();
    expect(revokeMock).toHaveBeenCalledWith("share-3");
    expect(errorMock).toHaveBeenCalled();
  });
});
