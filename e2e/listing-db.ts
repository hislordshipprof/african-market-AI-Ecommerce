import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";

async function withStore<T>(
  storeSlug: string,
  run: (tx: Prisma.TransactionClient, storeId: string) => Promise<T>,
): Promise<T> {
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  try {
    const store = await prisma.store.findUniqueOrThrow({ where: { slug: storeSlug } });
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
      return run(tx, store.id);
    });
  } finally {
    await prisma.$disconnect();
  }
}

export type ListingStock = {
  maxPerOrder: number | null;
  stockMode: string;
  status: string | null;
  qty: number | null;
};

export async function storeIdentity(storeSlug: string) {
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  try {
    const store = await prisma.store.findUniqueOrThrow({
      where: { slug: storeSlug },
      select: { id: true, slug: true },
    });
    return store;
  } finally {
    await prisma.$disconnect();
  }
}

export async function readListingStock(storeSlug: string, listingId: string): Promise<ListingStock> {
  return withStore(storeSlug, async (tx, storeId) => {
    const listing = await tx.listing.findFirstOrThrow({
      where: { id: listingId, storeId },
      select: { maxPerOrder: true, stockMode: true, status: true, qty: true },
    });
    return listing;
  });
}

export async function writeListingStock(
  storeSlug: string,
  listingId: string,
  stock: ListingStock,
): Promise<void> {
  await withStore(storeSlug, async (tx, storeId) => {
    const listing = await tx.listing.findFirstOrThrow({
      where: { id: listingId, storeId },
      select: { id: true },
    });
    await tx.listing.update({
      where: { id: listing.id },
      data: stock,
    });
  });
}

export async function readCartLines(storeSlug: string, cartId: string) {
  return withStore(storeSlug, async (tx, storeId) => {
    const lines = await tx.cartLine.findMany({
      where: { cartId, storeId },
      include: { variant: { select: { price: true, label: true, listingId: true } } },
      orderBy: { createdAt: "asc" },
    });
    return lines.map((line) => ({
      id: line.id,
      variantId: line.variantId,
      listingId: line.variant.listingId,
      qty: line.qty,
      price: line.variant.price,
      label: line.variant.label,
      swapRule: line.swapRule,
      substituteVariantId: line.substituteVariantId,
    }));
  });
}

export async function deleteCartLine(storeSlug: string, lineId: string): Promise<boolean> {
  return withStore(storeSlug, async (tx, storeId) => {
    const line = await tx.cartLine.findFirst({
      where: { id: lineId, storeId },
      select: { id: true },
    });
    if (!line) return false;
    await tx.cartLine.delete({ where: { id: line.id } });
    return true;
  });
}

export async function writeCartLine(
  storeSlug: string,
  lineId: string,
  data: { qty?: number; swapRule?: string; substituteVariantId?: string | null },
): Promise<boolean> {
  return withStore(storeSlug, async (tx, storeId) => {
    const line = await tx.cartLine.findFirst({
      where: { id: lineId, storeId },
      select: { id: true },
    });
    if (!line) return false;
    await tx.cartLine.update({ where: { id: line.id }, data });
    return true;
  });
}

export async function findListingVariants(storeSlug: string, listingName: string) {
  return withStore(storeSlug, async (tx, storeId) => {
    const listing = await tx.listing.findFirst({
      where: { storeId, customName: listingName },
      include: { variants: { orderBy: { id: "asc" } } },
    });
    if (!listing) throw new Error(`listing ${listingName} not found`);
    return {
      id: listing.id,
      price: listing.price,
      variants: listing.variants.map((variant) => ({
        id: variant.id,
        label: variant.label,
        price: variant.price,
        weightG: variant.weightG,
      })),
    };
  });
}

/** Puts the variant in a cart so a delete-and-recreate save cannot succeed. */
export async function seedCartLine(storeSlug: string, variantId: string) {
  return withStore(storeSlug, async (tx, storeId) => {
    const cart = await tx.cart.create({ data: { storeId } });
    return tx.cartLine.create({
      data: { storeId, cartId: cart.id, variantId, qty: 1 },
    });
  });
}
