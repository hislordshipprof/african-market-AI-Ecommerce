let loggedMissingEventKey = false;

export function productionRuntime(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === "production" || env.VERCEL === "1";
}

/** Local Dev Server may send without an event key. Vercel stays in cloud mode. */
export function devServerWithoutKey(env: Record<string, string | undefined> = process.env): boolean {
  if (env.VERCEL) return false;
  return env.INNGEST_DEV === "1";
}

/**
 * True when production has no event key and is not on the Dev Server.
 * The log is once per process.
 */
export function blockInngestSend(env: Record<string, string | undefined> = process.env): boolean {
  if (devServerWithoutKey(env)) return false;
  if (env.INNGEST_EVENT_KEY) return false;
  if (!productionRuntime(env)) return false;
  if (!loggedMissingEventKey) {
    loggedMissingEventKey = true;
    console.error(JSON.stringify({ event: "inngest_event_key_missing" }));
  }
  return true;
}
