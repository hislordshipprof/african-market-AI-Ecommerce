import { execSync } from "child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

export default async function globalSetup() {
  if (process.env.CI) return;
  execSync("npx tsx prisma/seed.ts", { stdio: "inherit" });
  // Every local spec pays from one address (::1) and payment setup allows 20 an hour per IP (#713), so a rerun
  // within the hour would be refused. Each run starts at zero, like CI's fresh database.
  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  try {
    await prisma.appRateLimit.deleteMany({ where: { key: { startsWith: "payment:ip:" } } });
  } finally {
    await prisma.$disconnect();
  }
}
