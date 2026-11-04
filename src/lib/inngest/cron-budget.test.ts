import { describe, expect, it } from "vitest";
import { reconcileStuckTransitional, sweepOrphanedAuthorized } from "./functions";

function cronOf(fn: { opts: { triggers?: Array<{ cron?: string }> } }): string | undefined {
  return fn.opts.triggers?.find((trigger) => trigger.cron)?.cron;
}

/** Idle runs of a star-slash-N cron across a 30-day month. */
function monthlyRuns(cron: string): number {
  const match = cron.match(/^\*\/(\d+) \* \* \* \*$/);
  if (!match) throw new Error(`unsupported cron ${cron}`);
  return Math.floor((30 * 24 * 60) / Number(match[1]));
}

describe("Inngest cron budget (ADR-0016)", () => {
  it("keeps the two idle sweeps at 5,760 runs per month", () => {
    const orphan = cronOf(sweepOrphanedAuthorized);
    const reconcile = cronOf(reconcileStuckTransitional);
    expect(orphan).toBe("*/15 * * * *");
    expect(reconcile).toBe("*/15 * * * *");
    const total = monthlyRuns(orphan!) + monthlyRuns(reconcile!);
    expect(total).toBe(5_760);
    expect(total).toBeLessThan(35_000);
  });
});
