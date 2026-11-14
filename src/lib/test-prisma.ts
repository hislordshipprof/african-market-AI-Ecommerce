import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * How long a Vitest Prisma client waits to open a transaction (Prisma's default is 2 s).
 * A client's first transaction opens a new connection, so a short stall in new
 * Postgres connections failed whole files in beforeAll (#372, #401).
 * Used by the shared client in db.ts under Vitest and by testPrismaClient.
 */
export const VITEST_TRANSACTION_MAX_WAIT_MS = 15_000;

/** A Prisma client for tests that build their own, with the Vitest transaction wait. */
export function testPrismaClient(url: string = process.env.DATABASE_URL!): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg(url),
    transactionOptions: { maxWait: VITEST_TRANSACTION_MAX_WAIT_MS },
  });
}
