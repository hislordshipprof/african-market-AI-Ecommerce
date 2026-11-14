import { beforeEach, describe, expect, it, vi } from "vitest";
const { entries, cached, invalidated } = vi.hoisted(() => ({ entries: new Map<string, { tags: string[]; value: unknown }>(), cached: vi.fn(), invalidated: vi.fn() }));
vi.mock("next/cache", () => ({
  unstable_cache: (read: () => Promise<unknown>, keys: string[], options: { tags: string[] }) => {
    cached(keys, options);
    return async () => {
      const key = keys.join("|");
      if (!entries.has(key)) entries.set(key, { tags: options.tags, value: await read() });
      return entries.get(key)!.value;
    };
  },
  revalidateTag: (tag: string, profile: unknown) => { invalidated(tag, profile); for (const [key, entry] of entries) if (entry.tags.includes(tag)) entries.delete(key); },
}));
import { cachedStorefrontRead, revalidateStorefront } from "./cache";
describe("storefront cache", () => {
  beforeEach(() => { entries.clear(); vi.clearAllMocks(); });
  it("invalidates a cached empty store immediately after seeding/mutation without evicting another tenant", async () => {
    let shelves: string[] = [];
    const read = vi.fn(async () => shelves);
    expect(await cachedStorefrontRead("a", "listings", read)).toEqual([]);
    await cachedStorefrontRead("b", "listings", async () => ["store b"]);
    shelves = ["egusi"];
    expect(await cachedStorefrontRead("a", "listings", read)).toEqual([]);
    revalidateStorefront("a");
    expect(await cachedStorefrontRead("a", "listings", read)).toEqual(["egusi"]);
    expect(await cachedStorefrontRead("b", "listings", async () => [])).toEqual(["store b"]);
    expect(invalidated).toHaveBeenCalledWith("storefront:a", { expire: 0 });
  });
  it("store operation and deployment keys remain distinct including a missing deployment id", async () => {
    const previous = process.env.VERCEL_DEPLOYMENT_ID;
    delete process.env.VERCEL_DEPLOYMENT_ID;
    const detailKey = JSON.stringify(["getListingDetail", "mn_egusi"]);
    expect(await cachedStorefrontRead("store-a", detailKey, async () => ({ id: "mn_egusi" }))).toEqual({ id: "mn_egusi" });
    expect(cached).toHaveBeenCalledWith(
      ["storefront-v3", "local", "store-a", detailKey],
      { tags: ["storefront:store-a"], revalidate: 60 },
    );
    process.env.VERCEL_DEPLOYMENT_ID = "dep_226";
    expect(await cachedStorefrontRead("store-b", detailKey, async () => ({ id: "tm_egusi" }))).toEqual({ id: "tm_egusi" });
    expect(cached).toHaveBeenCalledWith(
      ["storefront-v3", "dep_226", "store-b", detailKey],
      { tags: ["storefront:store-b"], revalidate: 60 },
    );
    delete process.env.VERCEL_DEPLOYMENT_ID;
    expect(await cachedStorefrontRead("store-a", detailKey, async () => ({ id: "leak" }))).toEqual({ id: "mn_egusi" });
    if (previous === undefined) delete process.env.VERCEL_DEPLOYMENT_ID;
    else process.env.VERCEL_DEPLOYMENT_ID = previous;
  });

  it("keeps query keys separate and tags every read with its store", async () => {
    expect(await cachedStorefrontRead("a", "search:egusi", async () => ["egusi"])).toEqual(["egusi"]);
    expect(await cachedStorefrontRead("a", "search:garri", async () => ["garri"])).toEqual(["garri"]);
    expect(cached).toHaveBeenCalledWith(expect.arrayContaining(["a", "search:garri"]), { tags: ["storefront:a"], revalidate: 60 });
  });
});
