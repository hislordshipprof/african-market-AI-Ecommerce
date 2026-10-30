import { describe, it, expect, vi } from "vitest";
import {
  storeTagsForSlug,
  storeTagsForId,
  revalidateStore,
} from "./get-store";

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
});
