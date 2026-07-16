import { beforeEach, describe, expect, it, vi } from "vitest";
import { usersApi } from "@/lib/api/users";

vi.mock("@/lib/api/users", () => ({
  usersApi: { updateMe: vi.fn() },
}));

const updateMe = vi.mocked(usersApi.updateMe);

// The serializer keeps module-level in-flight state; re-import a fresh copy
// per test so one test's pending queue can't leak into the next.
async function freshPersist() {
  vi.resetModules();
  const imported = await import("./unit-preference");
  return imported.persistUnitPreference;
}

function deferred() {
  let resolve!: (value: Awaited<ReturnType<typeof usersApi.updateMe>>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Awaited<ReturnType<typeof usersApi.updateMe>>>(
    (res, rej) => {
      resolve = res;
      reject = rej;
    },
  );
  return { promise, resolve, reject };
}

const ok = {} as Awaited<ReturnType<typeof usersApi.updateMe>>;

describe("persistUnitPreference", () => {
  beforeEach(() => {
    updateMe.mockReset();
  });

  it("sends a single PATCH for a single change", async () => {
    const persist = await freshPersist();
    updateMe.mockResolvedValueOnce(ok);

    persist("imperial");
    await vi.waitFor(() => expect(updateMe).toHaveBeenCalledTimes(1));
    expect(updateMe).toHaveBeenCalledWith({
      preferences: { units: "imperial" },
    });
  });

  it("serializes rapid toggles and only persists the latest selection", async () => {
    const persist = await freshPersist();
    const first = deferred();
    updateMe.mockReturnValueOnce(first.promise).mockResolvedValueOnce(ok);

    // Three clicks before the first PATCH settles: the intermediate
    // "metric" must never be sent — an unordered stale-last write is
    // exactly what the account-wins reconciliation would propagate back.
    persist("imperial");
    persist("metric");
    persist("imperial");
    expect(updateMe).toHaveBeenCalledTimes(1);

    first.resolve(ok);
    await vi.waitFor(() => expect(updateMe).toHaveBeenCalledTimes(2));
    expect(updateMe).toHaveBeenNthCalledWith(2, {
      preferences: { units: "imperial" },
    });
  });

  it("still sends the queued selection when the in-flight PATCH fails", async () => {
    const persist = await freshPersist();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = deferred();
    updateMe.mockReturnValueOnce(first.promise).mockResolvedValueOnce(ok);

    persist("imperial");
    persist("metric");
    first.reject(new Error("backend unreachable"));

    await vi.waitFor(() => expect(updateMe).toHaveBeenCalledTimes(2));
    expect(updateMe).toHaveBeenNthCalledWith(2, {
      preferences: { units: "metric" },
    });
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to save unit preference",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});
