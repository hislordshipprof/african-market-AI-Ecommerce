import { execSync } from "child_process";

export default function globalSetup() {
  if (process.env.CI) return;
  execSync("npx tsx prisma/seed.ts", { stdio: "inherit" });
}
