import { describe, expect, it, vi } from "vitest";
import { signOutTo } from "./sign-out";

describe("signOutTo", () => {
  it("ends the session, then leaves for the sign-in it was given", async () => {
    const calls: string[] = [];
    const signOut = vi.fn(async () => {
      calls.push("signOut");
      return { data: { success: true }, error: null };
    });
    const leave = vi.fn((path: string) => calls.push(`leave:${path}`));

    await expect(signOutTo("/store-admin/sign-in?store=mama-ngozi", signOut, leave)).resolves.toBe(true);
    expect(calls).toEqual(["signOut", "leave:/store-admin/sign-in?store=mama-ngozi"]);
  });

  it("stays on the page when the server refuses the sign-out", async () => {
    const leave = vi.fn();
    const result = await signOutTo("/admin/sign-in", async () => ({ data: null, error: { status: 500 } }), leave);
    expect(result).toBe(false);
    expect(leave).not.toHaveBeenCalled();
  });

  it("stays on the page when the network fails", async () => {
    const leave = vi.fn();
    const result = await signOutTo("/admin/sign-in", async () => { throw new TypeError("Failed to fetch"); }, leave);
    expect(result).toBe(false);
    expect(leave).not.toHaveBeenCalled();
  });
});
