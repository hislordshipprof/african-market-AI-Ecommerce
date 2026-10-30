import { defineConfig } from "prisma/config";
import { resolveDirectUrl } from "./src/lib/env";

let directUrl: string;
try {
  directUrl = resolveDirectUrl();
} catch {
  directUrl = "";
}

export default defineConfig({
  schema: "./prisma/schema.prisma",
  engine: "classic",
  datasource: {
    url: directUrl,
  },
  migrations: {
    seed: "tsx ./prisma/seed.ts",
  },
} as Parameters<typeof defineConfig>[0]);
