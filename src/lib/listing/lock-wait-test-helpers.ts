import type { Client } from "pg";

/**
 * Test-only helpers for stock-event lock waits.
 * App code must not import this module. It talks to Postgres through `pg`.
 * The lock signal is only an ungranted pg_locks row for the waited-on pid.
 */

export function pgError(error: unknown): { code: string; message: string } {
  if (typeof error === "object" && error !== null) {
    const code = "code" in error && error.code != null ? String(error.code) : "";
    const message = error instanceof Error ? error.message : "";
    return { code, message };
  }
  return { code: "", message: "" };
}

export async function backendPid(client: Client): Promise<number> {
  const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return rows[0].pid;
}

export async function waitForLockWait(observer: Client, pid: number): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query(
      "SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted LIMIT 1",
      [pid],
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the overlapping statement never waited on a lock");
}
