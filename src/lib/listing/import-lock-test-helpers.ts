import { Client, type ClientConfig } from "pg";

/**
 * Test-only helpers for ordering two CSV import commits on a held store row.
 * App code must not import this module. It talks to Postgres through `pg`.
 * The lock signal is only the recursive pg_locks / pg_blocking_pids count.
 */

const WAITER_SQL = `WITH RECURSIVE waiters AS (
  SELECT l.pid
  FROM pg_locks l
  WHERE NOT l.granted AND $1 = ANY(pg_blocking_pids(l.pid))
  UNION
  SELECT l.pid
  FROM pg_locks l
  JOIN waiters w ON w.pid = ANY(pg_blocking_pids(l.pid))
  WHERE NOT l.granted
)
SELECT COUNT(DISTINCT pid)::int AS n FROM waiters`;

export const LOCK_WAIT_POLL_MS = 20;
export const LOCK_WAIT_TIMEOUT_MS = 10_000;
/** Room for a 1.5s delay, two 10s waits, setup, and cleanup. A Vitest timeout does not cancel the commits. */
export const OVERLAP_TEST_TIMEOUT_MS = 45_000;
export const HOLDER_APPLICATION_NAME = "import-lock-holder";

export type StoreRowHold = {
  pid: number;
  commit(): Promise<void>;
  rollback(): Promise<void>;
};

export type LockClient = {
  connect(): Promise<void>;
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rowCount?: number | null; rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
  on(event: "error", listener: (err: Error) => void): unknown;
};

export type LockObserver = LockClient;

type HoldOptions = {
  timeoutMs?: number;
  /** Isolates pg_stat_activity counts when another file holds a store row at the same time. */
  applicationName?: string;
  createClient?: (connectionString: string, timeoutMs: number) => LockClient;
};

type WaitOptions = {
  label: string;
  timeoutMs?: number;
  settled?: Promise<unknown>[];
  openObserver?: () => LockObserver;
};

type CountOptions = {
  timeoutMs?: number;
  openObserver?: () => LockObserver;
};

type Settlement =
  | { status: "fulfilled" }
  | { status: "rejected"; reason: unknown };

type QueryFn = (this: Client, ...args: unknown[]) => unknown;

type DelayRule = {
  table: RegExp;
  value: string;
  ms: number;
  consumed: boolean;
  fired: boolean;
  pending: Promise<unknown> | null;
};

const delayRules: DelayRule[] = [];
let nativeQuery: QueryFn | null = null;

function prototypeQuery(): QueryFn {
  return (Client.prototype as unknown as { query: QueryFn }).query;
}

function setPrototypeQuery(query: QueryFn) {
  (Client.prototype as unknown as { query: QueryFn }).query = query;
}

function dispatcher(this: Client, ...args: unknown[]): unknown {
  const rule = delayRules.find((candidate) => !candidate.consumed && delayMatches(candidate, args));
  const next = nativeQuery ?? prototypeQuery();
  if (!rule) return next.apply(this, args);
  rule.consumed = true;
  rule.fired = true;
  const pending = new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        Promise.resolve(next.apply(this, args)).then(resolve, reject);
      } catch (err) {
        reject(err);
      }
    }, rule.ms);
  });
  void pending.catch(() => undefined);
  rule.pending = pending;
  return pending;
}

function ensureDelayInstalled() {
  const current = prototypeQuery();
  if (current === dispatcher) return;
  nativeQuery = current;
  setPrototypeQuery(dispatcher);
}

function delayMatches(rule: DelayRule, args: unknown[]): boolean {
  if (typeof args[args.length - 1] === "function") return false;
  const first = args[0];
  if (first && typeof first === "object" && typeof (first as { submit?: unknown }).submit === "function") {
    return false;
  }
  let text = "";
  let values: unknown[] = [];
  if (typeof first === "string") {
    text = first;
    if (Array.isArray(args[1])) values = args[1] as unknown[];
  } else if (first && typeof first === "object" && "text" in first) {
    text = String((first as { text: unknown }).text);
    const bound = (first as { values?: unknown }).values;
    if (Array.isArray(bound)) values = bound;
  } else {
    return false;
  }
  if (!/^\s*select\b/i.test(text) || !rule.table.test(text)) return false;
  return values.some((value) => value === rule.value);
}

export function delayFirstQuery(options: { table: string; value: string; ms: number }): {
  restore: () => Promise<void>;
  fired: () => boolean;
} {
  ensureDelayInstalled();
  const rule: DelayRule = {
    table: new RegExp(`\\b${options.table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
    value: options.value,
    ms: options.ms,
    consumed: false,
    fired: false,
    pending: null,
  };
  delayRules.push(rule);
  return {
    fired: () => rule.fired,
    restore: async () => {
      const index = delayRules.indexOf(rule);
      if (index >= 0) delayRules.splice(index, 1);
      if (delayRules.length === 0 && prototypeQuery() === dispatcher && nativeQuery) {
        setPrototypeQuery(nativeQuery);
        nativeQuery = null;
      }
      if (rule.pending) await rule.pending.catch(() => undefined);
    },
  };
}

export function directUrlForLane(env: NodeJS.ProcessEnv = process.env): string {
  const appUrl = env.DATABASE_URL?.trim();
  if (!appUrl) throw new Error("DATABASE_URL is required");
  const unpooled = env.DATABASE_URL_UNPOOLED?.trim();
  const direct = unpooled || env.DIRECT_URL?.trim();
  if (!direct) {
    throw new Error(
      "Neither DATABASE_URL_UNPOOLED nor DIRECT_URL is set (or both are empty). " +
        "Migrations and seeds require a direct (non-pooled) connection string.",
    );
  }
  let app: URL;
  let chosen: URL;
  try {
    app = new URL(appUrl);
    chosen = new URL(direct);
  } catch {
    throw new Error("direct URL does not target the lane database");
  }
  const portOf = (url: URL) => url.port || (url.protocol === "postgres:" || url.protocol === "postgresql:" ? "5432" : "");
  if (app.hostname !== chosen.hostname || portOf(app) !== portOf(chosen) || app.pathname !== chosen.pathname) {
    throw new Error("direct URL does not target the lane database");
  }
  return direct;
}

function defaultLockClient(connectionString: string, timeoutMs: number, applicationName: string): LockClient {
  const client = new Client({
    connectionString,
    application_name: applicationName,
    connectionTimeoutMillis: Math.max(1000, timeoutMs),
    query_timeout: timeoutMs,
  } as ClientConfig);
  return client as unknown as LockClient;
}

function track(promises: Promise<unknown>[]): { current(): Settlement | null } {
  const states: Array<Settlement | null> = promises.map(() => null);
  promises.forEach((promise, index) => {
    promise.then(
      () => {
        if (!states[index]) states[index] = { status: "fulfilled" };
      },
      (reason: unknown) => {
        if (!states[index]) states[index] = { status: "rejected", reason };
      },
    );
  });
  return {
    current() {
      for (const state of states) {
        if (state?.status === "rejected") return state;
      }
      for (const state of states) {
        if (state?.status === "fulfilled") return state;
      }
      return null;
    },
  };
}

function throwIfSettled(tracker: { current(): Settlement | null }, label: string) {
  const state = tracker.current();
  if (!state) return;
  if (state.status === "rejected") throw state.reason;
  throw new Error(`commit settled before it queued on the store lock: ${label}`);
}

async function withinDeadline<T>(
  work: Promise<T>,
  deadline: number,
  label: string,
  errorOf?: () => Error | null,
): Promise<T> {
  void work.catch(() => undefined);
  const timedOut = () => new Error(`timed out: ${label}`);
  const left = deadline - Date.now();
  if (left <= 0) throw timedOut();
  const existing = errorOf?.();
  if (existing) throw existing;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const handles: {
      timer?: ReturnType<typeof setTimeout>;
      poll?: ReturnType<typeof setInterval>;
    } = {};
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      if (handles.timer) clearTimeout(handles.timer);
      if (handles.poll) clearInterval(handles.poll);
      run();
    };
    handles.timer = setTimeout(() => finish(() => reject(timedOut())), left);
    handles.poll = setInterval(() => {
      const err = errorOf?.();
      if (err) finish(() => reject(err));
    }, 5);
    work.then(
      (value) => finish(() => {
        const err = errorOf?.();
        if (err) reject(err);
        else if (Date.now() >= deadline) reject(timedOut());
        else resolve(value);
      }),
      (err: unknown) => finish(() => {
        if (Date.now() >= deadline) reject(timedOut());
        else reject(errorOf?.() ?? err);
      }),
    );
  });
}

function startCommit<T>(run: () => Promise<T>): Promise<T> {
  let promise: Promise<T>;
  try {
    promise = Promise.resolve(run());
  } catch (err) {
    promise = Promise.reject(err);
  }
  void promise.catch(() => undefined);
  return promise;
}

export async function holdStoreRow(storeId: string, options?: HoldOptions): Promise<StoreRowHold> {
  const timeoutMs = options?.timeoutMs ?? LOCK_WAIT_TIMEOUT_MS;
  const applicationName = options?.applicationName?.trim() || HOLDER_APPLICATION_NAME;
  const connectionString = directUrlForLane();
  const deadline = Date.now() + timeoutMs;
  const client = (options?.createClient ?? ((cs, ms) => defaultLockClient(cs, ms, applicationName)))(
    connectionString,
    timeoutMs,
  );
  let clientError: Error | null = null;
  client.on("error", (err) => {
    clientError = err;
  });
  let ended = false;
  const endOnce = async () => {
    if (ended) return;
    ended = true;
    await client.end().catch(() => undefined);
  };
  try {
    const holderError = () => clientError;
    await withinDeadline(client.connect(), deadline, "hold store row", holderError);
    await withinDeadline(client.query("BEGIN"), deadline, "hold store row", holderError);
    const locked = await withinDeadline(
      client.query("SELECT 1 FROM stores WHERE id = $1 FOR UPDATE", [storeId]),
      deadline,
      "hold store row",
      holderError,
    );
    if ((locked.rowCount ?? 0) !== 1) throw new Error("store row not locked");
    const who = await withinDeadline(
      client.query("SELECT pg_backend_pid() AS pid"),
      deadline,
      "hold store row",
      holderError,
    );
    const pid = Number(who.rows[0]?.pid ?? 0);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("store row not locked");
    if (clientError) throw clientError;
    let finished = false;
    const finish = async (sql: "COMMIT" | "ROLLBACK") => {
      if (finished) return;
      finished = true;
      try {
        await client.query(sql);
        if (clientError) throw clientError;
      } finally {
        await endOnce();
      }
    };
    return {
      pid,
      commit: () => finish("COMMIT"),
      rollback: () => finish("ROLLBACK"),
    };
  } catch (err) {
    // Disconnect aborts an open transaction. A ROLLBACK queued behind a
    // still-running FOR UPDATE would wait on itself.
    await endOnce();
    throw err;
  }
}

export async function countLockWaiters(holderPid: number, options?: CountOptions): Promise<number> {
  const timeoutMs = options?.timeoutMs ?? LOCK_WAIT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const observer = options?.openObserver
    ? options.openObserver()
    : defaultLockClient(directUrlForLane(), timeoutMs, "import-lock-observer");
  let observerError: Error | null = null;
  observer.on("error", (err) => {
    observerError = err;
  });
  try {
    const errorOf = () => observerError;
    await withinDeadline(observer.connect(), deadline, "count lock waiters", errorOf);
    const result = await withinDeadline(
      observer.query(WAITER_SQL, [holderPid]),
      deadline,
      "count lock waiters",
      errorOf,
    );
    if (observerError) throw observerError;
    return Number(result.rows[0]?.n ?? 0);
  } finally {
    await observer.end().catch(() => undefined);
  }
}

export async function assertNoLockWaiters(holderPid: number): Promise<void> {
  const count = await countLockWaiters(holderPid);
  if (count !== 0) throw new Error(`nonzero lock-waiter baseline: ${count}`);
}

export async function waitForLockWaiters(holderPid: number, atLeast: number, options: WaitOptions): Promise<void> {
  if (!Number.isInteger(atLeast) || atLeast < 1) {
    throw new Error(`lock waiter threshold must be a positive count, received ${String(atLeast)}`);
  }
  const label = options.label;
  const timeoutMs = options.timeoutMs ?? LOCK_WAIT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const tracker = track(options.settled ?? []);
  let observer: LockObserver | null = null;
  let sleepTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.resolve();
    throwIfSettled(tracker, label);
    if (Date.now() >= deadline) throw new Error(`timed out: ${label}`);
    observer = options.openObserver
      ? options.openObserver()
      : defaultLockClient(directUrlForLane(), timeoutMs, "import-lock-observer");
    let observerError: Error | null = null;
    observer.on("error", (err) => {
      observerError = err;
    });
    const failObserver = () => {
      if (observerError) throw observerError;
    };
    const errorOf = () => observerError;
    await withinDeadline(observer.connect(), deadline, label, errorOf);
    failObserver();
    throwIfSettled(tracker, label);
    for (;;) {
      failObserver();
      throwIfSettled(tracker, label);
      if (Date.now() >= deadline) throw new Error(`timed out: ${label}`);
      const result = await withinDeadline(observer.query(WAITER_SQL, [holderPid]), deadline, label, errorOf);
      failObserver();
      throwIfSettled(tracker, label);
      if (Date.now() >= deadline) throw new Error(`timed out: ${label}`);
      if (Number(result.rows[0]?.n ?? 0) >= atLeast) return;
      const pause = Math.min(LOCK_WAIT_POLL_MS, deadline - Date.now());
      if (pause <= 0) throw new Error(`timed out: ${label}`);
      await new Promise<void>((resolve) => {
        sleepTimer = setTimeout(resolve, pause);
      });
    }
  } finally {
    if (sleepTimer) clearTimeout(sleepTimer);
    if (observer) await observer.end().catch(() => undefined);
  }
}

export async function abandonHeldCommits(hold: StoreRowHold, commits: Promise<unknown>[]): Promise<void> {
  try {
    await hold.rollback();
  } catch {
    // The caller rethrows the original failure. Settlement still runs.
  } finally {
    await Promise.allSettled(commits);
  }
}

export async function commitPairBehindStoreLock<T>(options: {
  storeId: string;
  first: () => Promise<T>;
  second: () => Promise<T>;
}): Promise<{ first: T; second: T }> {
  const hold = await holdStoreRow(options.storeId);
  const commits: Promise<unknown>[] = [];
  try {
    await assertNoLockWaiters(hold.pid);
    const first = startCommit(options.first);
    commits.push(first);
    await waitForLockWaiters(hold.pid, 1, {
      label: "first commit queued on store lock",
      settled: [first],
    });
    const second = startCommit(options.second);
    commits.push(second);
    await waitForLockWaiters(hold.pid, 2, {
      label: "second commit queued on store lock",
      settled: [first, second],
    });
    await hold.commit();
    return { first: await first, second: await second };
  } catch (err) {
    await abandonHeldCommits(hold, commits);
    throw err;
  }
}
