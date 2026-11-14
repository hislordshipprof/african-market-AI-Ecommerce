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

export function storeTagsForDomain(domain: string): string[] {
  return [`store-domain:${domain}`];
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

function findStoreByDomainPersistent(
  domain: string,
): Promise<ValidatedStore | null> {
  return unstable_cache(
    async () => {
      const store = await platform.store.findUnique({
        where: { customDomain: domain },
      });
      if (!store) return null;
      return validateStore(store);
    },
    ["store-by-domain", domain],
    {
      revalidate: STORE_CACHE_REVALIDATE,
      tags: [`store-domain:${domain}`],
    },
  )();
}

export const findStoreByDomain = cache(
  async (domain: string): Promise<ValidatedStore | null> => {
    return findStoreByDomainPersistent(domain);
  },
);

export function revalidateStore(store: {
  id: string;
  slug: string;
  customDomain?: string | null;
}): void {
  const tags = [
    ...storeTagsForSlug(store.slug),
    ...storeTagsForId(store.id),
  ];
  if (store.customDomain) {
    tags.push(...storeTagsForDomain(store.customDomain));
  }
  for (const tag of tags) {
    revalidateTag(tag, { expire: 0 });
  }
}

/** The host's store from the proxy's headers: the subdomain slug, else a custom domain. */
export async function findStoreForHeaders(
  headerList: Headers,
): Promise<ValidatedStore | null> {
  const slug = headerList.get("x-store-slug");
  if (slug) return findStore(slug);
  const customDomain = headerList.get("x-custom-domain");
  if (customDomain) return findStoreByDomain(customDomain);
  return null;
}

export async function getStore(): Promise<ValidatedStore> {
  const store = await findStoreForHeaders(await headers());
  if (!store) notFound();
  return store;
}

export async function getStoreWithStatus(): Promise<{
  store: ValidatedStore;
  suspended: boolean;
}> {
  const store = await getStore();
  return { store, suspended: store.status === "suspended" };
}
