import { describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ authPrisma: {}, platformAdmin: {} }));

import { userIsPrivileged } from "./privileged-user";

const customer = { role: "customer", twoFactorEnabled: false, emailVerified: true, memberships: [] };

describe("userIsPrivileged", () => {
  it("2FA on a verified account is privileged", () => {
    expect(userIsPrivileged({ ...customer, twoFactorEnabled: true })).toBe(true);
  });

  it("2FA on an unverified account is ignored, so the mailbox owner can reclaim it by magic link", () => {
    expect(userIsPrivileged({ ...customer, twoFactorEnabled: true, emailVerified: false })).toBe(false);
  });

  it("staff role or a store membership stays privileged even unverified", () => {
    expect(userIsPrivileged({ ...customer, emailVerified: false, role: "platform_admin" })).toBe(true);
    expect(userIsPrivileged({ ...customer, emailVerified: false, twoFactorEnabled: true, memberships: [{ id: "m1" }] })).toBe(true);
  });
});
