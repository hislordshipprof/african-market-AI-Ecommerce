import { execSync } from "node:child_process";

if (process.env.VERCEL_ENV === "preview") {
  console.log("Preview deployment — seeding demo stores");
  execSync("npx tsx prisma/seed.ts", { stdio: "inherit" });
}
