import { execSync } from "node:child_process";

const run = (cmd) => execSync(cmd, { stdio: "inherit" });

run("prisma generate");

const migrationUrl =
  process.env.DATABASE_URL_UNPOOLED ||
  process.env.DIRECT_URL ||
  process.env.DATABASE_URL;

if (migrationUrl) {
  run("prisma migrate deploy");
} else {
  console.log("No database URL — skipping prisma migrate deploy");
}

run("npx next build");
