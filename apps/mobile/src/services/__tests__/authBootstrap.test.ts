import { bootstrapAuth } from "../authBootstrap";
import type { User } from "@/types";

function user(id: string): User {
  return { id, email: id + "@example.com" } as User;
}

describe("bootstrapAuth", () => {
  it("ends loading as signed out when no token exists", async () => {
    const setUser = jest.fn();
    await bootstrapAuth({
      isAuthenticated: () => false,
      getCachedProfile: () => null,
      getProfile: jest.fn(),
      setUser,
      setLoading: jest.fn(),
    });
    expect(setUser).toHaveBeenCalledWith(null);
  });

  it("hydrates the cached rider before refreshing from the backend", async () => {
    const cached = user("cached");
    const fresh = user("fresh");
    const setUser = jest.fn();
    await bootstrapAuth({
      isAuthenticated: () => true,
      getCachedProfile: () => cached,
      getProfile: async () => fresh,
      setUser,
      setLoading: jest.fn(),
    });
    expect(setUser.mock.calls).toEqual([[cached], [fresh]]);
  });

  it("keeps the cached rider on an offline refresh failure", async () => {
    const cached = user("cached");
    const setUser = jest.fn();
    const setLoading = jest.fn();
    await bootstrapAuth({
      isAuthenticated: () => true,
      getCachedProfile: () => cached,
      getProfile: async () => {
        throw new Error("offline");
      },
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
      isAuthenticated: () => authenticated,
      getCachedProfile: () => user("cached"),
      getProfile: async () => {
        authenticated = false;
        throw new Error("unauthorized");
      },
      setUser,
      setLoading: jest.fn(),
    });
    expect(setUser).toHaveBeenLastCalledWith(null);
  });
});
