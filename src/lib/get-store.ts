import { cache } from "react";
import { unstable_cache, revalidateTag } from "next/cache";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { platform } from "./db";
import { VALID_PRESETS, type ThemePreset } from "./theme";
import type { Store } from "@prisma/client";

const BRAND_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

export type ValidatedStore = Store & {
  validPreset: ThemePreset;
  validBrandColor: string | null;
};

const STORE_CACHE_REVALIDATE = 300;

function validateStore(store: Store): ValidatedStore {
  const validPreset = (
    VALID_PRESETS as readonly string[]
  ).includes(store.themePreset)
    ? (store.themePreset as ThemePreset)
    : "palm-and-shea";
  const validBrandColor =
    store.brandColor && BRAND_COLOR_RE.test(store.brandColor)
      ? store.brandColor
      : null;
  return { ...store, validPreset, validBrandColor };
}

export function storeTagsForSlug(slug: string): string[] {
  return [`store-slug:${slug}`];
}

export function storeTagsForId(id: string): string[] {
  return [`store:${id}`];
}

function findStorePersistent(slug: string): Promise<ValidatedStore | null> {
  return unstable_cache(
    async () => {
      const store = await platform.store.findUnique({ where: { slug } });
      if (!store) return null;
      return validateStore(store);
    },
    ["store-by-slug", slug],
    {
      revalidate: STORE_CACHE_REVALIDATE,
      tags: [`store-slug:${slug}`],
    },
  )();
}

export const findStore = cache(
  async (slug: string): Promise<ValidatedStore | null> => {
    return findStorePersistent(slug);
  },
);

export function revalidateStore(store: { id: string; slug: string }): void {
  for (const tag of [
    ...storeTagsForSlug(store.slug),
    ...storeTagsForId(store.id),
  ]) {
    revalidateTag(tag, { expire: 0 });
  }
}

export async function getStore(): Promise<ValidatedStore> {
  const headerList = await headers();
  const slug = headerList.get("x-store-slug");
  if (!slug) notFound();
  const store = await findStore(slug);
  if (!store) notFound();
  return store;
}
