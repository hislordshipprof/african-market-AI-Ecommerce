import { prisma } from "./db";
import type { Store } from "@prisma/client";

export async function resolveStore(
  host: string | null,
  searchParams?: URLSearchParams,
): Promise<Store | null> {
  let slug: string | null = null;

  if (
    searchParams &&
    process.env.VERCEL_ENV !== "production"
  ) {
    slug = searchParams.get("store");
  }

  if (!slug && host) {
    const firstLabel = host.split(".")[0];
    if (firstLabel && firstLabel !== "localhost" && firstLabel !== "www") {
      slug = firstLabel;
    }
  }

  if (!slug) return null;

  return prisma.store.findUnique({ where: { slug } });
}
