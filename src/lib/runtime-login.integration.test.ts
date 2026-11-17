import { afterAll, describe, expect, it } from "vitest";
import { testPrismaClient } from "@/lib/test-prisma";
import { refuseUnsafeDatabaseLogin } from "./runtime-login";

const hasRuntime = !!process.env.DATABASE_URL && !!process.env.APP_RUNTIME_PASSWORD;

describe.skipIf(!hasRuntime)("production startup refuses a database login that could bypass RLS (#713)", () => {
  // The owning login (app_owner on lanes and CI): it owns the tables, so RLS does not hold it unless forced.
  const owner = testPrismaClient();
  const unreachable = testPrismaClient("postgresql://app_runtime:x@127.0.0.1:1/none");

  afterAll(async () => {
    await owner.$disconnect();
    await unreachable.$disconnect();
  });

  it("passes in production for the app_runtime login", async () => {
    expect(await refuseUnsafeDatabaseLogin({ NODE_ENV: "production" })).toBe("ok");
  });

  it("refuses to start in production on the table owner's login", async () => {
    await expect(refuseUnsafeDatabaseLogin({ NODE_ENV: "production" }, owner)).rejects.toThrow(/app_runtime/);
  });

  it("does not check outside production or during the production build", async () => {
    expect(await refuseUnsafeDatabaseLogin({ NODE_ENV: "development" }, owner)).toBe("skipped");
    expect(await refuseUnsafeDatabaseLogin({ NODE_ENV: "test" }, owner)).toBe("skipped");
    expect(await refuseUnsafeDatabaseLogin({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" }, owner)).toBe("skipped");
  });

  it("starts when the database cannot be reached, since no query can bypass RLS then", async () => {
    expect(await refuseUnsafeDatabaseLogin({ NODE_ENV: "production" }, unreachable)).toBe("unchecked");
  });
});
