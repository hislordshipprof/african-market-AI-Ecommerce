import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "./prisma/schema.prisma",
  engine: "classic",
  datasource: {
    url:
      process.env.DATABASE_URL_UNPOOLED ?? process.env.DIRECT_URL ?? "",
  },
  migrations: {
    seed: "tsx ./prisma/seed.ts",
  },
} as Parameters<typeof defineConfig>[0]);
