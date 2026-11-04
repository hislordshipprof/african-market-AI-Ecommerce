import { catalogImageUrl } from "../r2";
import { catalogFor } from "./catalog";
import { isRetiredRemote } from "./editorial";

/**
 * Raw storefront key extraction. Does not trim, strip queries or fragments, or decode.
 * `storefrontPhoto` is the only caller that turns a match into a photo URL.
 */
export function catalogKeyFromUrl(url: string): string | undefined {
  return url.match(/^(?:\/api\/catalog-image\/)?(catalog\/[a-zA-Z0-9._-]+\.(?:jpg|png|webp))$/)?.[1]
    ?? url.match(/^https:\/\/[^/]+\/(catalog\/[a-zA-Z0-9._-]+\.(?:jpg|png|webp))$/)?.[1];
}

/** Resolve stored R2 keys against today's public host, including legacy route URLs. */
export function storefrontPhoto(url: string | null | undefined): string | undefined {
  if (!url || url.endsWith(".svg")) return undefined;
  if (isRetiredRemote(url)) return undefined;
  const key = catalogKeyFromUrl(url);
  return key ? catalogImageUrl(key) : url;
}

export function listingImage(listing: {
  imageUrl?: string | null;
  customName?: string | null;
  masterProduct?: { name: string; imageUrl?: string | null } | null;
}) {
  const cutout = [listing.customName, listing.masterProduct?.name].map(name => catalogFor(name)?.imageUrl).find(url => url?.startsWith("/images/products/"));
  return storefrontPhoto(listing.imageUrl)
    ?? storefrontPhoto(listing.masterProduct?.imageUrl)
    ?? (cutout?.startsWith("/images/products/") ? cutout : undefined);
}
