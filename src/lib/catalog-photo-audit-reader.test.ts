import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  platform: { masterProduct: { findMany } },
  platformSessionUser: async () => "app_runtime",
  disconnectPlatformClient: async () => undefined,
  storeScoped: () => {
    throw new Error("storeScoped");
  },
  platformAdmin: new Proxy({}, {
    get() {
      throw new Error("platformAdmin");
    },
  }),
  authPrisma: new Proxy({}, {
    get() {
      throw new Error("authPrisma");
    },
  }),
}));

import { readMasterProductsForPhotoAudit } from "./catalog-photo-audit-reader";

describe("photo audit reader guard", () => {
  beforeEach(() => {
    findMany.mockReset();
    findMany.mockResolvedValue([{ id: "1", name: "Yam", status: "rejected", imageUrl: null }]);
  });

  it("reader permits only scalar findMany with no relations or writes (E9, E28)", async () => {
    const rows = await readMasterProductsForPhotoAudit();
    expect(rows).toEqual([{ id: "1", name: "Yam", status: "rejected", imageUrl: null }]);
    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0]?.[0];
    expect(args).toEqual({
      select: { id: true, name: true, status: true, imageUrl: true },
    });
    expect(args).not.toHaveProperty("include");
    expect(args).not.toHaveProperty("where");
    expect(JSON.stringify(args)).not.toContain("listings");
    expect(JSON.stringify(args)).not.toContain("_count");
  });
});
