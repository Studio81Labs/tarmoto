import { bootstrapAuth } from "../authBootstrap";
import type { User } from "@/types";

function user(id: string): User {
  return { id, email: id + "@example.com" } as User;
}

describe("bootstrapAuth", () => {
  it("ends loading as signed out when no token exists", async () => {
    const setUser = jest.fn();
    await bootstrapAuth({
      getSessionSnapshot: () => null,
      getCachedProfile: () => null,
      getProfile: jest.fn(),
      cacheProfile: jest.fn(),
      setUser,
      setLoading: jest.fn(),
    });
    expect(setUser).toHaveBeenCalledWith(null);
  });

  it("hydrates the cached rider before refreshing from the backend", async () => {
    const cached = user("cached");
    const fresh = user("fresh");
    const setUser = jest.fn();
    const cacheProfile = jest.fn();
    await bootstrapAuth({
      getSessionSnapshot: () => ({
        accessToken: "token",
        userId: fresh.id,
      }),
      getCachedProfile: () => cached,
      getProfile: async () => fresh,
      cacheProfile,
      setUser,
      setLoading: jest.fn(),
    });
    expect(setUser.mock.calls).toEqual([[cached], [fresh]]);
    expect(cacheProfile).toHaveBeenCalledWith(fresh);
  });

  it("keeps the cached rider on an offline refresh failure", async () => {
    const cached = user("cached");
    const setUser = jest.fn();
    const setLoading = jest.fn();
    await bootstrapAuth({
      getSessionSnapshot: () => ({
        accessToken: "token",
        userId: cached.id,
      }),
      getCachedProfile: () => cached,
      getProfile: async () => {
        throw new Error("offline");
      },
      cacheProfile: jest.fn(),
      setUser,
      setLoading,
    });
    expect(setUser).toHaveBeenCalledTimes(1);
    expect(setUser).toHaveBeenCalledWith(cached);
    expect(setLoading).toHaveBeenCalledWith(false);
  });

  it("clears the rider when refresh invalidates the token", async () => {
    let authenticated = true;
    const setUser = jest.fn();
    await bootstrapAuth({
      getSessionSnapshot: () =>
        authenticated ? { accessToken: "token", userId: "cached" } : null,
      getCachedProfile: () => user("cached"),
      getProfile: async () => {
        authenticated = false;
        throw new Error("unauthorized");
      },
      cacheProfile: jest.fn(),
      setUser,
      setLoading: jest.fn(),
    });
    expect(setUser).toHaveBeenLastCalledWith(null);
  });

  it("discards an upgraded-install refresh after an account switch", async () => {
    let session = {
      accessToken: "account-a-token",
      userId: null as string | null,
    };
    let resolveProfile!: (profile: User) => void;
    const cacheProfile = jest.fn();
    const setUser = jest.fn();
    const setLoading = jest.fn();
    const bootstrap = bootstrapAuth({
      getSessionSnapshot: () => session,
      getCachedProfile: () => null,
      getProfile: () =>
        new Promise<User>((resolve) => {
          resolveProfile = resolve;
        }),
      cacheProfile,
      setUser,
      setLoading,
    });

    session = { accessToken: "account-b-token", userId: "account-b" };
    resolveProfile(user("account-a"));
    await bootstrap;

    expect(cacheProfile).not.toHaveBeenCalled();
    expect(setUser).not.toHaveBeenCalled();
    expect(setLoading).toHaveBeenCalledWith(false);
  });
});
