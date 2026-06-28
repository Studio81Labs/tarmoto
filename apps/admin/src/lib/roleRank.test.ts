import { describe, it, expect } from "vitest";
import { canAccess, ROLE_RANK } from "./roleRank.js";
import type { AdminRole } from "./roleRank.js";

describe("ROLE_RANK", () => {
  it("assigns strictly increasing ranks across the four roles", () => {
    expect(ROLE_RANK.read_only).toBeLessThan(ROLE_RANK.support);
    expect(ROLE_RANK.support).toBeLessThan(ROLE_RANK.admin);
    expect(ROLE_RANK.admin).toBeLessThan(ROLE_RANK.super_admin);
  });
});

describe("canAccess", () => {
  it("returns true when role equals minRole", () => {
    const roles: AdminRole[] = ["read_only", "support", "admin", "super_admin"];
    for (const role of roles) {
      expect(canAccess(role, role)).toBe(true);
    }
  });

  it("returns true when role exceeds minRole", () => {
    expect(canAccess("support", "read_only")).toBe(true);
    expect(canAccess("admin", "read_only")).toBe(true);
    expect(canAccess("admin", "support")).toBe(true);
    expect(canAccess("super_admin", "read_only")).toBe(true);
    expect(canAccess("super_admin", "support")).toBe(true);
    expect(canAccess("super_admin", "admin")).toBe(true);
  });

  it("returns false when role is below minRole", () => {
    expect(canAccess("read_only", "support")).toBe(false);
    expect(canAccess("read_only", "admin")).toBe(false);
    expect(canAccess("read_only", "super_admin")).toBe(false);
    expect(canAccess("support", "admin")).toBe(false);
    expect(canAccess("support", "super_admin")).toBe(false);
    expect(canAccess("admin", "super_admin")).toBe(false);
  });

  // Route-gating matrix: overview → read_only, users → support, administrators → admin
  it("route-gating: read_only can access overview only", () => {
    expect(canAccess("read_only", "read_only")).toBe(true);
    expect(canAccess("read_only", "support")).toBe(false);
    expect(canAccess("read_only", "admin")).toBe(false);
  });

  it("route-gating: support can access overview and users but not administrators", () => {
    expect(canAccess("support", "read_only")).toBe(true);
    expect(canAccess("support", "support")).toBe(true);
    expect(canAccess("support", "admin")).toBe(false);
  });

  it("route-gating: admin can access overview, users, and administrators", () => {
    expect(canAccess("admin", "read_only")).toBe(true);
    expect(canAccess("admin", "support")).toBe(true);
    expect(canAccess("admin", "admin")).toBe(true);
  });

  it("route-gating: super_admin can access all gated routes", () => {
    expect(canAccess("super_admin", "read_only")).toBe(true);
    expect(canAccess("super_admin", "support")).toBe(true);
    expect(canAccess("super_admin", "admin")).toBe(true);
  });
});
