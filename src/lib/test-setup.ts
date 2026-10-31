import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const envLocalPath = resolve(process.cwd(), ".env.local");
if (existsSync(envLocalPath)) {
  for (const line of readFileSync(envLocalPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
}

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
