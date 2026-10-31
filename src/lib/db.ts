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
};

export async function platformAdminTransaction<T>(
  fn: (tx: Pick<PrismaClient, "store" | "auditLog">) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return fn({ store: tx.store, auditLog: tx.auditLog });
  });
}

export { prisma as authPrisma };
