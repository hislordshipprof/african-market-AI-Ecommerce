import { describe, expect, it, vi } from "vitest";
import { signOutAdmin } from "./sign-out";

describe("signOutAdmin", () => {
  it("ends the session, then returns to admin sign-in", async () => {
    const calls: string[] = [];
    const signOut = vi.fn(async () => {
      calls.push("signOut");
      return { data: { success: true }, error: null };
    });
    const leave = vi.fn((path: string) => calls.push(`leave:${path}`));

    await expect(signOutAdmin(signOut, leave)).resolves.toBe(true);
    expect(calls).toEqual(["signOut", "leave:/admin/sign-in"]);
  });

  it("stays on the page when the server refuses the sign-out", async () => {
    const leave = vi.fn();
    const result = await signOutAdmin(async () => ({ data: null, error: { status: 500 } }), leave);
    expect(result).toBe(false);
    expect(leave).not.toHaveBeenCalled();
  });

  it("stays on the page when the network fails", async () => {
    const leave = vi.fn();
    const result = await signOutAdmin(async () => { throw new TypeError("Failed to fetch"); }, leave);
    expect(result).toBe(false);
    expect(leave).not.toHaveBeenCalled();
  });
});
