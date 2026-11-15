import { Client } from "pg";
import { platformAdminTransaction } from "../db";

type Knobs = {
  goLiveListingFloor?: number;
  aiDailySamplePerStore?: number;
  aiTurnCostFlagCents?: number;
  rejectedApplicationRetentionMonths?: number;
};

/**
 * Test-only. Test files that write the AI and onboarding columns of the shared platform_settings row (#561) run their
 * body under one session advisory lock, so two files never change them at once, and the columns are put back after.
 * Files that only read them pick fixtures that hold under any value a writer sets: cost threshold 1 to 20 cents.
 */
export async function withAiOnboardingSettings<T>(patch: Knobs, fn: () => Promise<T>): Promise<T> {
  const lock = new Client({ connectionString: process.env.DATABASE_URL });
  await lock.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(hashtext('test:platform_settings:ai_onboarding'))");
    const write = (data: Knobs) => platformAdminTransaction((tx) => tx.platformSettings.update({ where: { id: "platform" }, data }));
    const original = await platformAdminTransaction((tx) => tx.platformSettings.findUniqueOrThrow({
      where: { id: "platform" },
      select: { goLiveListingFloor: true, aiDailySamplePerStore: true, aiTurnCostFlagCents: true, rejectedApplicationRetentionMonths: true },
    }));
    try {
      if (Object.keys(patch).length > 0) await write(patch);
      return await fn();
    } finally {
      await write(original);
    }
  } finally {
    await lock.end();
  }
}
