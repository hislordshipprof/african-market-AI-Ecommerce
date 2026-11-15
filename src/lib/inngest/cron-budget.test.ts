import { describe, expect, it } from "vitest";
import { copilotDailyDigest } from "../copilot/digest";
import { copilotWeeklyReport } from "../copilot/weekly-report";
import { courierRegistrationRetry } from "../delivery/courier-functions";
import { assistantRetention, dailyConfidence, directoryStoreRequestNotices, inngestFunctions, reconcileStuckTransitional, storeApplicationRetention, sweepOrphanedAuthorized } from "./functions";

function cronOf(fn: { opts: { triggers?: ReadonlyArray<{ cron?: string } | { event: string }> } }): string | undefined {
  return fn.opts.triggers?.flatMap((trigger) => ("cron" in trigger && trigger.cron ? [trigger.cron] : []))[0];
}

/** Idle runs across a 30-day month. Daily crons are UTC so DST cannot double them. */
function monthlyRuns(cron: string): number {
  const interval = cron.match(/^\*\/(\d+) \* \* \* \*$/);
  if (interval) return Math.floor((30 * 24 * 60) / Number(interval[1]));
  if (/^TZ=UTC \d+ \d+ \* \* \*$/.test(cron)) return 30;
  if (/^TZ=UTC \d+ \* \* \* \*$/.test(cron)) return 30 * 24;
  throw new Error(`unsupported cron ${cron}`);
}

describe("Inngest cron budget (ADR-0016)", () => {
  it("keeps idle crons under the free tier", () => {
    const orphan = cronOf(sweepOrphanedAuthorized);
    const reconcile = cronOf(reconcileStuckTransitional);
    const retention = cronOf(assistantRetention);
    const confidence = cronOf(dailyConfidence);
    const digest = cronOf(copilotDailyDigest);
    const weekly = cronOf(copilotWeeklyReport);
    const courierRetry = cronOf(courierRegistrationRetry);
    const applications = cronOf(storeApplicationRetention);
    expect(orphan).toBe("*/15 * * * *");
    expect(reconcile).toBe("*/15 * * * *");
    expect(retention).toBe("TZ=UTC 17 3 * * *");
    expect(confidence).toBe("TZ=UTC 23 9 * * *");
    expect(digest).toBe("TZ=UTC 0 * * * *");
    expect(courierRetry).toBe("TZ=UTC 41 6 * * *");
    expect(applications).toBe("TZ=UTC 29 3 * * *");
    expect(inngestFunctions).toContain(storeApplicationRetention);
    const storeRequests = cronOf(directoryStoreRequestNotices);
    expect(storeRequests).toBe("TZ=UTC 7 15 * * *");
    expect(inngestFunctions).toContain(directoryStoreRequestNotices);
    expect(inngestFunctions).toContain(courierRegistrationRetry);
    expect(weekly).toBe("TZ=UTC 0 * * * *");
    expect(inngestFunctions).toContain(dailyConfidence);
    expect(inngestFunctions).toContain(copilotDailyDigest);
    expect(inngestFunctions).toContain(copilotWeeklyReport);
    const total = monthlyRuns(orphan!) + monthlyRuns(reconcile!) + monthlyRuns(retention!) + monthlyRuns(confidence!)
      + monthlyRuns(digest!) + monthlyRuns(courierRetry!) + monthlyRuns(applications!) + monthlyRuns(storeRequests!) + monthlyRuns(weekly!);
    expect(total).toBe(7_350);
    expect(total).toBeLessThan(35_000);
  });
});
