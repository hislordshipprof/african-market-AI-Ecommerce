import { describe, it, expect, vi } from "vitest";

vi.mock("./db", () => ({
  authPrisma: {
    user: { findUnique: vi.fn() },
    session: { deleteMany: vi.fn() },
  },
}));

import { auth } from "./auth";

describe("auth config", () => {
  it("has session cookie cache disabled globally", () => {
    const opts = auth.options as Record<string, unknown>;
    const session = opts.session as Record<string, unknown>;
    const cookieCache = session.cookieCache as Record<string, unknown>;
    expect(cookieCache.enabled).toBe(false);
  });
});
