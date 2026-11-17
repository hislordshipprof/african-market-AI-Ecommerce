import type { PrismaClient } from "@prisma/client";
import { assertAppRuntimeLogin, UnsafeDatabaseLoginError } from "./db";

/**
 * Production checks its database login once at startup (#713). A login that is not app_runtime, or that could bypass
 * RLS, throws, and Next then answers every request with an error. A check that cannot reach the database is logged
 * and the server starts: no query runs on any login then, and a database blip must not keep an instance down.
 */
export async function refuseUnsafeDatabaseLogin(
  env: Record<string, string | undefined>,
  client?: Pick<PrismaClient, "$transaction">,
): Promise<"skipped" | "ok" | "unchecked"> {
  if (env.NODE_ENV !== "production" || env.NEXT_PHASE === "phase-production-build") return "skipped";
  try {
    await assertAppRuntimeLogin(client);
    return "ok";
  } catch (error) {
    if (error instanceof UnsafeDatabaseLoginError) {
      console.error(JSON.stringify({ event: "db_login_refused", message: error.message }));
      throw error;
    }
    console.error(JSON.stringify({ event: "db_login_unchecked", message: String(error) }));
    return "unchecked";
  }
}
