import { PrismaClient, Prisma } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export function storeScoped(storeId: string) {
  return prisma.$extends({
    query: {
      $allOperations({ args, query, operation }) {
        const readOps = ["findUnique", "findFirst", "findMany", "count", "aggregate", "groupBy"];
        const isRead = readOps.includes(operation);

        return prisma.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`;
            await tx.$executeRaw`SET ROLE app_user`;
            return query(args);
          },
          { isolationLevel: isRead ? Prisma.TransactionIsolationLevel.ReadCommitted : undefined },
        );
      },
    },
  });
}

export type StoreScopedClient = ReturnType<typeof storeScoped>;
