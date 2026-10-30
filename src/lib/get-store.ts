import { cache } from "react";
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

export const findStore = cache(
  async (slug: string): Promise<ValidatedStore | null> => {
    const store = await platform.store.findUnique({ where: { slug } });
    if (!store) return null;
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
  },
);

export async function getStore(): Promise<ValidatedStore> {
  const headerList = await headers();
  const slug = headerList.get("x-store-slug");
  if (!slug) notFound();
  const store = await findStore(slug);
  if (!store) notFound();
  return store;
}
