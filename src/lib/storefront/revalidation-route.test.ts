import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/cache", () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }));
import { revalidateTag } from "next/cache";
import { POST } from "@/app/api/storefront/revalidate/route";
describe("seed revalidation bridge", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("STOREFRONT_REVALIDATION_SECRET", "test-only-cache-secret"); });
  afterEach(() => vi.unstubAllEnvs());
  const request = (body: unknown, token = "test-only-cache-secret") => new Request("http://localhost/api/storefront/revalidate", { method: "POST", headers: { authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  it("rejects unauthenticated cache purges", async () => {
    expect((await POST(request({ stores: [{ id: "a", slug: "shop" }] }, "wrong"))).status).toBe(401);
    expect(revalidateTag).not.toHaveBeenCalled();
  });
  it("expires the seeded store and storefront tags after listing/banner/collection writes", async () => {
    expect((await POST(request({ stores: [{ id: "a", slug: "shop" }] }))).status).toBe(200);
    expect(revalidateTag).toHaveBeenCalledWith("storefront:a", { expire: 0 });
    expect(revalidateTag).toHaveBeenCalledWith("store-slug:shop", { expire: 0 });
    expect(revalidateTag).toHaveBeenCalledWith("store:a", { expire: 0 });
    expect(revalidateTag).toHaveBeenCalledTimes(3);
  });
  it("rejects malformed payloads before any invalidation", async () => {
    for (const stores of [null, [null], [{ id: "a" }], [{ id: "a".repeat(101), slug: "shop" }]]) {
      expect((await POST(request({ stores }))).status).toBe(400);
    }
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("no secret, wrong secret and short secret are 401; oversized store list is 400", async () => {
    vi.stubEnv("STOREFRONT_REVALIDATION_SECRET", "");
    expect((await POST(request({ stores: [{ id: "a", slug: "shop" }] }, ""))).status).toBe(401);
    vi.stubEnv("STOREFRONT_REVALIDATION_SECRET", "test-only-cache-secret");
    expect((await POST(request({ stores: [{ id: "a", slug: "shop" }] }, "wrong"))).status).toBe(401);
    expect((await POST(request({ stores: [{ id: "a", slug: "shop" }] }, "short"))).status).toBe(401);
    const stores = Array.from({ length: 51 }, (_, index) => ({ id: `s${index}`, slug: `shop-${index}` }));
    expect((await POST(request({ stores }))).status).toBe(400);
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});
