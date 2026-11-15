const CHICAGO = "America/Chicago";

/**
 * The handoff E2E store's prep time. Today's pickup slots start at now plus
 * prep and stop at local midnight; with no prep, two slots are left until 23:00.
 */
export const HANDOFF_PREP_MINUTES = 0;

/**
 * The store timezone the handoff E2E uses. In Chicago's 23:00 hour fewer than
 * two clock slots are left; Denver is an hour earlier and still has two.
 */
export function handoffTimezone(now: Date): string {
  const hour = Number(now.toLocaleString("en-US", { timeZone: CHICAGO, hour: "numeric", hourCycle: "h23" }));
  return hour === 23 ? "America/Denver" : CHICAGO;
}
