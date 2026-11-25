/** Store-local wall time ("YYYY-MM-DDTHH:MM", what a datetime-local input gives) to and from UTC. */
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Offset of `timeZone` from UTC at `at`, in ms. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(at).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** A `datetime-local` value read as wall time in the store's zone. */
export function storeLocalToUtc(local: string, timeZone: string): Date | null {
  const m = LOCAL_TIME.exec(local);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  if (Number.isNaN(wall)) return null;
  const first = wall - zoneOffsetMs(new Date(wall), timeZone);
  return new Date(wall - zoneOffsetMs(new Date(first), timeZone));
}

export function utcToStoreLocal(at: Date, timeZone: string): string {
  return new Date(at.getTime() + zoneOffsetMs(at, timeZone)).toISOString().slice(0, 16);
}
