import { beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

let prisma: PrismaClient | undefined;

if (process.env.DATABASE_URL) {
  const adapter = new PrismaPg(process.env.DATABASE_URL);
  prisma = new PrismaClient({ adapter });

  beforeAll(async () => {
    await prisma!.$connect();
  });

  afterAll(async () => {
    await prisma!.$disconnect();
  });
}
