const CHICAGO = "America/Chicago";

/**
 * The store timezone the handoff E2E uses. Today's pickup slots stop at local
 * midnight, so from 23:01 Chicago no clock slot is left; Denver is an hour
 * earlier and still has one.
 */
export function handoffTimezone(now: Date): string {
  const hour = Number(now.toLocaleString("en-US", { timeZone: CHICAGO, hour: "numeric", hourCycle: "h23" }));
  return hour === 23 ? "America/Denver" : CHICAGO;
}
