import { unstable_cache, revalidateTag } from "next/cache";

export const storefrontTag = (storeId: string) => `storefront:${storeId}`;

export function cachedStorefrontRead<T>(storeId: string, key: string, read: () => Promise<T>): Promise<T> {
  return unstable_cache(read, ["storefront-v3", process.env.VERCEL_DEPLOYMENT_ID ?? "local", storeId, key], {
    tags: [storefrontTag(storeId)], revalidate: 60,
  })();
}

/** Call only after the mutation commits, in a Server Action or Route Handler. */
export function revalidateStorefront(storeId: string): void {
  revalidateTag(storefrontTag(storeId), { expire: 0 });
}
