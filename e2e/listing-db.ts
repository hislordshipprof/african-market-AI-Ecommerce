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
