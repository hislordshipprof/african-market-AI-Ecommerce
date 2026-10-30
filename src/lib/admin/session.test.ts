import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetSession = vi.fn();

vi.mock("../auth", () => ({
  auth: {
    api: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
    },
  },
}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockRedirect = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    mockRedirect(path);
    throw new Error(`REDIRECT:${path}`);
  },
}));

import { requirePlatformAdmin } from "./session";

describe("requirePlatformAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects to sign-in when no session", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    await expect(requirePlatformAdmin()).rejects.toThrow("REDIRECT:/admin/sign-in");
    expect(mockRedirect).toHaveBeenCalledWith("/admin/sign-in");
  });

  it("redirects to sign-in for non-admin role", async () => {
    mockGetSession.mockResolvedValueOnce({
      user: { id: "u1", role: "customer", twoFactorEnabled: false },
    });
    await expect(requirePlatformAdmin()).rejects.toThrow("REDIRECT:/admin/sign-in");
  });

  it("redirects to enroll-2fa when admin has 2FA not enabled", async () => {
    mockGetSession.mockResolvedValueOnce({
      user: { id: "u1", role: "platform_admin", twoFactorEnabled: false },
    });
    await expect(requirePlatformAdmin()).rejects.toThrow("REDIRECT:/admin/enroll-2fa");
    expect(mockRedirect).toHaveBeenCalledWith("/admin/enroll-2fa");
  });

  it("returns session when admin has 2FA enabled", async () => {
    const session = {
      user: { id: "u1", role: "platform_admin", twoFactorEnabled: true },
    };
    mockGetSession.mockResolvedValueOnce(session);
    const result = await requirePlatformAdmin();
    expect(result).toBe(session);
  });

  it("allows unenrolled admin with allowUnenrolled2FA option", async () => {
    const session = {
      user: { id: "u1", role: "platform_admin", twoFactorEnabled: false },
    };
    mockGetSession.mockResolvedValueOnce(session);
    const result = await requirePlatformAdmin({ allowUnenrolled2FA: true });
    expect(result).toBe(session);
  });
});
