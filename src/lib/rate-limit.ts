const hits = new Map<string, number[]>();

const MAX_REQUESTS = 10;
const WINDOW_MS = 60_000;

export function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const timestamps = hits.get(ip) ?? [];
  const recent = timestamps.filter((t) => now - t < WINDOW_MS);

  if (recent.length >= MAX_REQUESTS) {
    hits.set(ip, recent);
    return true;
  }

  recent.push(now);
  hits.set(ip, recent);
  return false;
}
