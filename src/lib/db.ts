import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { runtimeDatabaseUrl } from "./env";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

if (!globalForPrisma.prisma) {
  const connectionUrl = process.env.DATABASE_URL
    ? runtimeDatabaseUrl(process.env)
    : undefined;
  const adapter = new PrismaPg(connectionUrl!);
  globalForPrisma.prisma = new PrismaClient({ adapter });
}

const prisma = globalForPrisma.prisma;

function wrapPlatformDelegate<D extends object>(delegate: D): D {
  return new Proxy(delegate as Record<string, unknown>, {
    get(target, prop: string) {
      const val = target[prop];
      if (typeof val !== "function") return val;
      return (...args: unknown[]) => {
        const prismaPromise = (val as (...a: unknown[]) => unknown).apply(
          target,
          args,
        );
        return prisma
          .$transaction([
            prisma.$executeRaw`SET LOCAL ROLE app_user`,
            prismaPromise as ReturnType<typeof prisma.$queryRaw>,
          ])
          .then(([, result]) => result);
      };
    },
  }) as unknown as D;
}

export const platform = {
  store: wrapPlatformDelegate(prisma.store),
  category: wrapPlatformDelegate(prisma.category),
  masterProduct: wrapPlatformDelegate(prisma.masterProduct),
  productSynonym: wrapPlatformDelegate(prisma.productSynonym),
};

function wrapDelegate<D extends object>(storeId: string, delegate: D): D {
  return new Proxy(delegate as Record<string, unknown>, {
    get(target, prop: string) {
      const val = target[prop];
      if (typeof val !== "function") return val;
      return (...args: unknown[]) => {
        const prismaPromise = (val as (...a: unknown[]) => unknown).apply(
          target,
          args,
        );
        return prisma
          .$transaction([
            prisma.$executeRaw`SET LOCAL ROLE app_user`,
            prisma.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`,
            prismaPromise as ReturnType<typeof prisma.$queryRaw>,
          ])
          .then(([, , result]) => result);
      };
    },
  }) as unknown as D;
}

export function storeScoped(storeId: string) {
  return {
    rlsTestFixture: wrapDelegate(storeId, prisma.rlsTestFixture),
    storeMembership: wrapDelegate(storeId, prisma.storeMembership),
    storeInvite: wrapDelegate(storeId, prisma.storeInvite),
    listing: wrapDelegate(storeId, prisma.listing),
    listingVariant: wrapDelegate(storeId, prisma.listingVariant),
    stockEvent: wrapDelegate(storeId, prisma.stockEvent),
    auditLog: wrapDelegate(storeId, prisma.auditLog),
    storeBanner: wrapDelegate(storeId, prisma.storeBanner),
    storeCollection: wrapDelegate(storeId, prisma.storeCollection),
    storeCollectionListing: wrapDelegate(storeId, prisma.storeCollectionListing),
    cart: wrapDelegate(storeId, prisma.cart),
    cartLine: wrapDelegate(storeId, prisma.cartLine),
  };
}

export type StoreScopedClient = ReturnType<typeof storeScoped>;

function wrapPlatformAdminDelegate<D extends object>(delegate: D): D {
  return new Proxy(delegate as Record<string, unknown>, {
    get(target, prop: string) {
      const val = target[prop];
      if (typeof val !== "function") return val;
      return (...args: unknown[]) => {
        const prismaPromise = (val as (...a: unknown[]) => unknown).apply(
          target,
          args,
        );
        return prisma
          .$transaction([
            prisma.$executeRaw`SET LOCAL ROLE app_user`,
            prisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
            prismaPromise as ReturnType<typeof prisma.$queryRaw>,
          ])
          .then(([, , result]) => result);
      };
    },
  }) as unknown as D;
}

export const platformAdmin = {
  store: wrapPlatformAdminDelegate(prisma.store),
  auditLog: wrapPlatformAdminDelegate(prisma.auditLog),
  storeMembership: wrapPlatformAdminDelegate(prisma.storeMembership),
  storeInvite: wrapPlatformAdminDelegate(prisma.storeInvite),
  masterProduct: wrapPlatformAdminDelegate(prisma.masterProduct),
  category: wrapPlatformAdminDelegate(prisma.category),
  productSynonym: wrapPlatformAdminDelegate(prisma.productSynonym),
};

export async function platformAdminTransaction<T>(
  fn: (tx: Pick<PrismaClient, "store" | "auditLog" | "storeMembership" | "storeInvite" | "masterProduct" | "category" | "productSynonym" | "$queryRaw">) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return fn({ store: tx.store, auditLog: tx.auditLog, storeMembership: tx.storeMembership, storeInvite: tx.storeInvite, masterProduct: tx.masterProduct, category: tx.category, productSynonym: tx.productSynonym, $queryRaw: tx.$queryRaw.bind(tx) });
  });
}

export async function storeScopedTransaction<T>(
  storeId: string,
  fn: (tx: Pick<PrismaClient, "listing" | "listingVariant" | "stockEvent" | "auditLog" | "cart" | "cartLine" | "$queryRaw">) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`;
    return fn({
      listing: tx.listing,
      listingVariant: tx.listingVariant,
      stockEvent: tx.stockEvent,
      auditLog: tx.auditLog,
      cart: tx.cart,
      cartLine: tx.cartLine,
      $queryRaw: tx.$queryRaw.bind(tx),
    });
  });
}

export async function lockStoreRow(tx: Pick<PrismaClient, "$queryRaw">, storeId: string) {
  await tx.$queryRaw`SELECT 1 FROM stores WHERE id = ${storeId} FOR UPDATE`;
}

export async function lockCartLineByVariant(
  tx: Pick<PrismaClient, "$queryRaw">,
  cartId: string,
  variantId: string,
): Promise<{ id: string; qty: number } | null> {
  const rows = await tx.$queryRaw<Array<{ id: string; qty: number }>>`
    SELECT id, qty FROM cart_lines
    WHERE cart_id = ${cartId} AND variant_id = ${variantId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

export async function storeScopedRawQuery<T>(
  storeId: string,
  sql: Prisma.Sql,
): Promise<T[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`;
    return tx.$queryRaw<T[]>(sql);
  });
}

export { Prisma };

export { prisma as authPrisma };

// No RLS wrapper: health checks read only system catalogs, not store-scoped tables.
export function healthQueryRaw(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<unknown[]> {
  return prisma.$queryRaw(strings, ...values) as Promise<unknown[]>;
}

export async function rateLimitUpsert(
  key: string,
  now: bigint,
  windowStart: bigint,
): Promise<{ count: number }> {
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    INSERT INTO rate_limits (id, key, count, last_request)
    VALUES (gen_random_uuid()::text, ${key}, 1, ${now})
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN rate_limits.last_request < ${windowStart}
        THEN 1
        ELSE rate_limits.count + 1
      END,
      last_request = ${now}
    RETURNING count
  `;
  return { count: Number(rows[0].count) };
}
