const hits = new Map<string, number[]>();

const MAX_REQUESTS = 10;
const WINDOW_MS = 60_000;
const EVICT_INTERVAL = 5 * 60_000;

let lastEvict = Date.now();

function evictStale(now: number) {
  if (now - lastEvict < EVICT_INTERVAL) return;
  lastEvict = now;
  for (const [key, timestamps] of hits) {
    const recent = timestamps.filter((t) => now - t < WINDOW_MS);
    if (recent.length === 0) {
      hits.delete(key);
    } else {
      hits.set(key, recent);
    }
  }
}

export function isRateLimited(ip: string): boolean {
  const now = Date.now();
  evictStale(now);

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
