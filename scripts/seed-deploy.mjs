import { execSync } from "node:child_process";

// Runs as postbuild, so a failed load fails the build before Vercel promotes the deployment.
if (process.env.VERCEL_ENV === "preview") {
  console.log("Preview deployment — seeding demo stores and catalog (no admin account)");
  execSync("npx tsx prisma/seed.ts", { stdio: "inherit" });
} else if (process.env.VERCEL_ENV === "production") {
  console.log("Production deployment — loading the master catalogue (no demo data)");
  execSync("npx tsx prisma/seed-production.ts", { stdio: "inherit" });
}
