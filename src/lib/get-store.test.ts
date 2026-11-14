import { describe, it, expect, vi } from "vitest";
import {
  storeTagsForSlug,
  storeTagsForDomain,
  storeTagsForId,
  revalidateStore,
  findStoreForHeaders,
} from "./get-store";

const mockFindUnique = vi.fn();
vi.mock("./db", () => ({
  platform: { store: { findUnique: (...args: unknown[]) => mockFindUnique(...args) } },
}));

vi.mock("next/cache", () => ({
  unstable_cache: vi.fn((fn: () => unknown) => fn),
  revalidateTag: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
}));

describe("storeTagsForSlug", () => {
  it("returns a store-slug tag", () => {
    expect(storeTagsForSlug("mama-ngozi")).toEqual(["store-slug:mama-ngozi"]);
  });
});

describe("storeTagsForDomain", () => {
  it("returns a store-domain tag", () => {
    expect(storeTagsForDomain("shop.mamasmarket.com")).toEqual([
      "store-domain:shop.mamasmarket.com",
    ]);
  });
});

describe("storeTagsForId", () => {
  it("returns a store id tag", () => {
    expect(storeTagsForId("abc-123")).toEqual(["store:abc-123"]);
  });
});

describe("revalidateStore", () => {
  it("revalidates both slug and id tags", async () => {
    const { revalidateTag } = await import("next/cache");
    vi.mocked(revalidateTag).mockClear();

    revalidateStore({ id: "store-1", slug: "mama-ngozi" });

    expect(revalidateTag).toHaveBeenCalledWith("store-slug:mama-ngozi", {
      expire: 0,
    });
    expect(revalidateTag).toHaveBeenCalledWith("store:store-1", { expire: 0 });
    expect(revalidateTag).toHaveBeenCalledTimes(2);
  });

  it("revalidates domain tag when customDomain is set", async () => {
    const { revalidateTag } = await import("next/cache");
    vi.mocked(revalidateTag).mockClear();

    revalidateStore({
      id: "store-1",
      slug: "mama-ngozi",
      customDomain: "shop.mamasmarket.com",
    });

    expect(revalidateTag).toHaveBeenCalledWith(
      "store-domain:shop.mamasmarket.com",
      { expire: 0 },
    );
    expect(revalidateTag).toHaveBeenCalledTimes(3);
  });

  it("does not revalidate domain tag when customDomain is null", async () => {
    const { revalidateTag } = await import("next/cache");
    vi.mocked(revalidateTag).mockClear();

    revalidateStore({ id: "store-1", slug: "mama-ngozi", customDomain: null });

    expect(revalidateTag).toHaveBeenCalledTimes(2);
  });
});

describe("findStoreForHeaders", () => {
  const row = { id: "s1", slug: "mama-ngozi", customDomain: "shop.mamasmarket.com", themePreset: "palm-and-shea", brandColor: null };

  it("resolves by x-store-slug first", async () => {
    mockFindUnique.mockReset().mockResolvedValueOnce(row);
    const store = await findStoreForHeaders(new Headers({ "x-store-slug": "mama-ngozi", "x-custom-domain": "other.example.com" }));
    expect(store?.id).toBe("s1");
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { slug: "mama-ngozi" } });
  });

  it("resolves a custom domain when no slug is set", async () => {
    mockFindUnique.mockReset().mockResolvedValueOnce(row);
    const store = await findStoreForHeaders(new Headers({ "x-custom-domain": "shop.mamasmarket.com" }));
    expect(store?.slug).toBe("mama-ngozi");
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { customDomain: "shop.mamasmarket.com" } });
  });

  it("returns null for an unknown custom domain or no store headers", async () => {
    mockFindUnique.mockReset().mockResolvedValueOnce(null);
    expect(await findStoreForHeaders(new Headers({ "x-custom-domain": "nobody.example.com" }))).toBeNull();
    expect(await findStoreForHeaders(new Headers())).toBeNull();
    expect(mockFindUnique).toHaveBeenCalledTimes(1);
  });
});
