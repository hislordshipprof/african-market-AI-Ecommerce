import { PrismaClient } from "@prisma/client";
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
};

export async function platformAdminTransaction<T>(
  fn: (tx: Pick<PrismaClient, "store" | "auditLog" | "storeMembership" | "storeInvite" | "masterProduct" | "$queryRaw">) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return fn({ store: tx.store, auditLog: tx.auditLog, storeMembership: tx.storeMembership, storeInvite: tx.storeInvite, $queryRaw: tx.$queryRaw.bind(tx) });
  });
}

export async function storeScopedTransaction<T>(
  storeId: string,
  fn: (tx: Pick<PrismaClient, "listing" | "listingVariant" | "stockEvent" | "auditLog" | "$queryRaw">) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`;
    return fn({
      listing: tx.listing,
      listingVariant: tx.listingVariant,
      stockEvent: tx.stockEvent,
      auditLog: tx.auditLog,
      $queryRaw: tx.$queryRaw.bind(tx),
    });
  });
}

export async function lockStoreRow(tx: Pick<PrismaClient, "$queryRaw">, storeId: string) {
  await tx.$queryRaw`SELECT 1 FROM "Store" WHERE id = ${storeId} FOR UPDATE`;
}

export { prisma as authPrisma };

// No RLS wrapper: health checks read only system catalogs, not store-scoped tables.
export function healthQueryRaw(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<unknown[]> {
  return prisma.$queryRaw(strings, ...values) as Promise<unknown[]>;
}
