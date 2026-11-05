import { readdirSync, readFileSync, statSync } from "fs";
import { createServer, type AddressInfo, type Socket } from "net";
import { join } from "path";
import { Client, Query } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeDatabaseUrl } from "../env";
import { IMPORT_TOKEN_TTL_MS } from "../db";
import {
  abandonHeldCommits,
  delayFirstQuery,
  directUrlForLane,
  holdStoreRow,
  waitForLockWaiters,
  type LockObserver,
} from "./import-lock-test-helpers";

const proto = Client.prototype as unknown as {
  query: (this: Client, ...args: unknown[]) => unknown;
};

function installQuery(impl: (this: Client, ...args: unknown[]) => unknown) {
  const original = proto.query;
  proto.query = impl;
  return () => {
    proto.query = original;
  };
}

const LISTING_SQL = "SELECT id FROM listing_imports WHERE id=$1";
const CLOSED_CLIENT = "Client was closed and is not queryable";

type QueryCall = (this: Client, ...args: unknown[]) => unknown;

function queryAs(client: Client, ...args: unknown[]): unknown {
  return (client.query as unknown as QueryCall).apply(client, args);
}

async function endedClient(): Promise<Client> {
  const client = new Client({ connectionString: "postgres://127.0.0.1:9/none" });
  await client.end();
  return client;
}

type NativeCall = { self: unknown; args: unknown[]; at: number };

function installCallThrough() {
  const original = proto.query;
  const seen: NativeCall[] = [];
  function wrapped(this: Client, ...args: unknown[]) {
    seen.push({ self: this, args, at: Date.now() });
    return original.apply(this, args);
  }
  proto.query = wrapped;
  return {
    seen,
    wrapped,
    restore() {
      proto.query = original;
    },
  };
}

function trackedCallback(label: string) {
  const calls: unknown[] = [];
  let settle: (err: unknown) => void = () => undefined;
  const done = new Promise<unknown>((resolve) => {
    settle = resolve;
  });
  const fn = (err: unknown) => {
    calls.push(err);
    settle(err);
  };
  return { label, fn, done, calls };
}

function expectDriverError(err: unknown) {
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toBe(CLOSED_CLIENT);
}

function expectClosedClient(result: unknown): Promise<void> {
  const captured = (result as Promise<unknown>).then(
    () => {
      throw new Error("expected the driver to reject the delayed query");
    },
    (reason: unknown) => reason,
  );
  return captured.then((err) => {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(CLOSED_CLIENT);
  });
}

async function awaitCallback(done: Promise<unknown>, label: string): Promise<unknown> {
  return Promise.race([
    done,
    new Promise<unknown>((_, reject) => {
      setTimeout(() => reject(new Error(`callback ${label} was not called`)), 500);
    }),
  ]);
}

function listingConfig(values: string[], extra?: Record<string, unknown>) {
  return { text: LISTING_SQL, values, ...extra };
}

function receiverCallbackConfig(kind: "own" | "inherited") {
  let observations = 0;
  const receivers: unknown[] = [];
  const fields = { text: LISTING_SQL, values: ["token"] };
  const config = kind === "own" ? fields : Object.assign(Object.create({}), fields);
  const host = kind === "own" ? config : (Object.getPrototypeOf(config) as object);
  let settle: (line: string) => void = () => undefined;
  const done = new Promise<string>((resolve) => {
    settle = resolve;
  });
  const fn = (err: unknown) => {
    settle(err instanceof Error ? err.message : String(err));
  };
  Object.defineProperty(host, "callback", {
    configurable: true,
    enumerable: true,
    get() {
      observations += 1;
      receivers.push(this);
      return this === config ? null : fn;
    },
  });
  return {
    config,
    done,
    receivers,
    observations: () => observations,
  };
}

describe("import lock test helpers", () => {
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of ["DATABASE_URL_UNPOOLED", "DIRECT_URL"] as const) {
      if (!(key in saved)) continue;
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
      delete saved[key];
    }
  });

  function remember(key: "DATABASE_URL_UNPOOLED" | "DIRECT_URL") {
    if (!(key in saved)) saved[key] = process.env[key];
  }

  it("integration coverage is not a skipped suite", () => {
    expect(process.env.DATABASE_URL, "DATABASE_URL must be set so the lock tests execute").toBeTruthy();
  });

  it("a 1.5s overlap delay stays inside the import token ttl", () => {
    expect(IMPORT_TOKEN_TTL_MS).toBe(30 * 60 * 1000);
    expect(1_500).toBeLessThan(IMPORT_TOKEN_TTL_MS);
  });

  it("deadline covers observer connect and query and rejects late success", async () => {
    const ended: string[] = [];
    await expect(waitForLockWaiters(11, 1, {
      label: "connect stall",
      timeoutMs: 40,
      openObserver: () => ({
        connect: () => new Promise<void>(() => undefined),
        query: async () => ({ rows: [{ n: 5 }] }),
        end: async () => {
          ended.push("connect");
        },
        on: () => undefined,
      }),
    })).rejects.toThrow("timed out: connect stall");

    await expect(waitForLockWaiters(11, 1, {
      label: "query stall",
      timeoutMs: 40,
      openObserver: () => ({
        connect: async () => undefined,
        query: () => new Promise(() => undefined),
        end: async () => {
          ended.push("query");
        },
        on: () => undefined,
      }),
    })).rejects.toThrow("timed out: query stall");

    let late = false;
    const pending = waitForLockWaiters(11, 1, {
      label: "late count",
      timeoutMs: 30,
      openObserver: () => ({
        connect: async () => undefined,
        query: () => new Promise((resolve) => {
          setTimeout(() => {
            late = true;
            resolve({ rows: [{ n: 9 }] });
          }, 80);
        }),
        end: async () => {
          ended.push("late");
        },
        on: () => undefined,
      }),
    });
    await expect(pending).rejects.toThrow("timed out: late count");
    expect(ended).toEqual(["connect", "query", "late"]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(late).toBe(true);
    await expect(pending).rejects.toThrow("timed out: late count");
  });

  it("early fulfillment fails and either rejection preserves its reason", async () => {
    let opened = false;
    const observer = (): LockObserver => {
      opened = true;
      throw new Error("observer opened");
    };
    await expect(waitForLockWaiters(4, 1, {
      label: "early",
      settled: [Promise.resolve("done")],
      openObserver: observer,
    })).rejects.toThrow("commit settled before it queued on the store lock: early");
    expect(opened).toBe(false);

    const reason = new Error("Import token is invalid, expired, or already used.");
    const rejected = Promise.reject(reason);
    void rejected.catch(() => undefined);
    await expect(waitForLockWaiters(4, 1, {
      label: "bad token",
      timeoutMs: 5_000,
      settled: [rejected],
      openObserver: observer,
    })).rejects.toBe(reason);
    expect(opened).toBe(false);

    const secondReason = new Error("second failed before the lock");
    const secondRejected = Promise.reject(secondReason);
    void secondRejected.catch(() => undefined);
    await expect(waitForLockWaiters(4, 2, {
      label: "second commit queued on store lock",
      settled: [new Promise(() => undefined), secondRejected],
      openObserver: observer,
    })).rejects.toBe(secondReason);
    expect(opened).toBe(false);

    let resolveDuring: (value: unknown) => void = () => undefined;
    const during = new Promise((resolve) => {
      resolveDuring = resolve;
    });
    let ended = false;
    await expect(waitForLockWaiters(4, 1, {
      label: "already settled",
      settled: [during],
      openObserver: () => ({
        connect: async () => undefined,
        query: async () => {
          resolveDuring("ok");
          await Promise.resolve();
          return { rows: [{ n: 3 }] };
        },
        end: async () => {
          ended = true;
        },
        on: () => undefined,
      }),
    })).rejects.toThrow("commit settled before it queued on the store lock: already settled");
    expect(ended).toBe(true);

    await expect(waitForLockWaiters(4, 0, { label: "zero" })).rejects.toThrow(
      /lock waiter threshold must be a positive count/,
    );
  });

  it("a stalled observer surfaces the commit outcome instead of a timeout", async () => {
    const reason = new Error("original commit error");
    const ended: string[] = [];
    const stall = (): LockObserver => ({
      connect: () => new Promise<void>(() => undefined),
      query: () => new Promise(() => undefined),
      end: async () => {
        ended.push("end");
      },
      on: () => undefined,
    });
    const started = Date.now();
    await expect(waitForLockWaiters(1, 1, {
      label: "query-reject",
      timeoutMs: 200,
      settled: [new Promise((_, reject) => {
        setTimeout(() => reject(reason), 20);
      })],
      openObserver: () => ({
        ...stall(),
        connect: async () => undefined,
      }),
    })).rejects.toBe(reason);
    expect(Date.now() - started).toBeLessThan(150);
    expect(ended).toEqual(["end"]);

    const fulfilled = new Promise((resolve) => {
      setTimeout(() => resolve("done"), 20);
    });
    await expect(waitForLockWaiters(1, 1, {
      label: "query-fulfill",
      timeoutMs: 200,
      settled: [fulfilled],
      openObserver: () => ({
        ...stall(),
        connect: async () => undefined,
      }),
    })).rejects.toThrow("commit settled before it queued on the store lock: query-fulfill");

    await expect(waitForLockWaiters(1, 1, {
      label: "connect-reject",
      timeoutMs: 200,
      settled: [new Promise((_, reject) => {
        setTimeout(() => reject(reason), 20);
      })],
      openObserver: () => ({
        ...stall(),
        query: async () => ({ rows: [{ n: 1 }] }),
      }),
    })).rejects.toBe(reason);
  });

  it("a stalled postgres handshake returns the commit error without waiting out the connection", async () => {
    const sockets = new Set<Socket>();
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.on("data", () => undefined);
      socket.on("error", () => undefined);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const previous = {
      DATABASE_URL: process.env.DATABASE_URL,
      DIRECT_URL: process.env.DIRECT_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
    };
    const url = `postgres://review:review@127.0.0.1:${port}/review`;
    process.env.DATABASE_URL = url;
    process.env.DIRECT_URL = url;
    delete process.env.DATABASE_URL_UNPOOLED;
    const reason = new Error("original commit failure");
    const started = Date.now();
    try {
      await expect(waitForLockWaiters(1, 1, {
        label: "stalled handshake",
        timeoutMs: 2_000,
        settled: [new Promise((_, reject) => {
          setTimeout(() => reject(reason), 20);
        })],
      })).rejects.toBe(reason);
      expect(Date.now() - started).toBeLessThan(500);
      const closedBy = Date.now() + 200;
      while (sockets.size > 0 && Date.now() < closedBy) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(sockets.size).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previous.DATABASE_URL === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous.DATABASE_URL;
      if (previous.DIRECT_URL === undefined) delete process.env.DIRECT_URL;
      else process.env.DIRECT_URL = previous.DIRECT_URL;
      if (previous.DATABASE_URL_UNPOOLED === undefined) delete process.env.DATABASE_URL_UNPOOLED;
      else process.env.DATABASE_URL_UNPOOLED = previous.DATABASE_URL_UNPOOLED;
    }
  });

  it("a stalled handshake timeout closes the accepted socket", async () => {
    const sockets = new Set<Socket>();
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.on("data", () => undefined);
      socket.on("error", () => undefined);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const previous = {
      DATABASE_URL: process.env.DATABASE_URL,
      DIRECT_URL: process.env.DIRECT_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
    };
    const url = `postgres://review:review@127.0.0.1:${port}/review`;
    process.env.DATABASE_URL = url;
    process.env.DIRECT_URL = url;
    delete process.env.DATABASE_URL_UNPOOLED;
    try {
      for (let i = 0; i < 6; i += 1) {
        await expect(waitForLockWaiters(1, 1, {
          label: `stalled timeout ${i}`,
          timeoutMs: 1_000,
        })).rejects.toThrow(`timed out: stalled timeout ${i}`);
        const closedBy = Date.now() + 200;
        while (sockets.size > 0 && Date.now() < closedBy) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(sockets.size).toBe(0);
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previous.DATABASE_URL === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous.DATABASE_URL;
      if (previous.DIRECT_URL === undefined) delete process.env.DIRECT_URL;
      else process.env.DIRECT_URL = previous.DIRECT_URL;
      if (previous.DATABASE_URL_UNPOOLED === undefined) delete process.env.DATABASE_URL_UNPOOLED;
      else process.env.DATABASE_URL_UNPOOLED = previous.DATABASE_URL_UNPOOLED;
    }
  }, 20_000);

  it("observer query failure and idle errors close the observer", async () => {
    let ended = 0;
    await expect(waitForLockWaiters(3, 1, {
      label: "observer query",
      openObserver: () => ({
        connect: async () => undefined,
        query: async () => {
          throw new Error("observer query failed");
        },
        end: async () => {
          ended += 1;
        },
        on: () => undefined,
      }),
    })).rejects.toThrow("observer query failed");
    expect(ended).toBe(1);

    await expect(waitForLockWaiters(3, 1, {
      label: "idle",
      timeoutMs: 2_000,
      openObserver: () => ({
        connect: async () => undefined,
        query: () => new Promise(() => undefined),
        end: async () => {
          ended += 1;
        },
        on: (_event, listener) => {
          setTimeout(() => listener(new Error("idle died")), 10);
        },
      }),
    })).rejects.toThrow("idle died");
    expect(ended).toBe(2);
  });

  it("the waiter poll only reads the recursive lock count", async () => {
    const sql: string[] = [];
    await waitForLockWaiters(8, 1, {
      label: "read only",
      timeoutMs: 50,
      openObserver: () => ({
        connect: async () => undefined,
        query: async (text: string) => {
          sql.push(text);
          return { rows: [{ n: 0 }] };
        },
        end: async () => undefined,
        on: () => undefined,
      }),
    }).catch((err: unknown) => {
      expect((err as Error).message).toBe("timed out: read only");
    });
    expect(sql.length).toBeGreaterThan(0);
    expect(sql.every((text) => text.includes("pg_blocking_pids"))).toBe(true);
    expect(sql.every((text) => text.includes("COUNT(DISTINCT pid)"))).toBe(true);
    expect(sql.every((text) => text.includes("UNION"))).toBe(true);
    expect(sql.join("\n")).not.toMatch(/\b(insert|update|delete|pg_stat_activity)\b/i);
    const source = readFileSync(join(process.cwd(), "src/lib/listing/import-lock-test-helpers.ts"), "utf8");
    expect(source.includes("pg_stat_activity")).toBe(false);
  });

  it("one-shot delay preserves config and delays forwarding exactly once", async () => {
    const seen: Array<{ self: unknown; args: unknown[]; at: number }> = [];
    const restoreProto = installQuery(function (this: Client, ...args: unknown[]) {
      seen.push({ self: this, args, at: Date.now() });
      return Promise.reject(new Error("driver down"));
    });
    const delay = delayFirstQuery({ table: "listing_imports", value: "token-1", ms: 80 });
    try {
      const client = new Client({ connectionString: "postgres://127.0.0.1:9/none" });
      const config = {
        text: "SELECT id FROM listing_imports WHERE id = $1",
        values: ["token-1"],
        rowMode: "array",
        types: { getTypeParser: () => null },
        name: "listing_import_read",
      };
      const started = Date.now();
      const delayed = client.query(config);
      const otherConfig = {
        text: "SELECT id FROM listing_imports WHERE id = $1",
        values: ["other-token"],
        rowMode: "array" as const,
        types: { getTypeParser: () => null },
      };
      const other = client.query(otherConfig);
      const update = client.query("UPDATE listing_imports SET status = $1 WHERE id = $2", ["pending", "token-1"]);
      const again = client.query(config);
      expect(delay.fired()).toBe(true);
      expect(seen.map((row) => row.args[0] === config || row.args[0] === otherConfig
        ? (row.args[0] as { values: string[] }).values
        : row.args[1])).toEqual([
        ["other-token"],
        ["pending", "token-1"],
        ["token-1"],
      ]);
      expect(Date.now() - started).toBeLessThan(40);
      await expect(Promise.all([other, update, again])).rejects.toThrow("driver down");
      expect(seen).toHaveLength(3);
      expect(seen[0]?.args[0]).toBe(otherConfig);
      await expect(delayed).rejects.toThrow("driver down");
      expect(seen).toHaveLength(4);
      expect(seen[3]?.self).toBe(client);
      expect(seen[3]?.args[0]).toBe(config);
      expect(seen[3]!.at - started).toBeGreaterThanOrEqual(70);
    } finally {
      await delay.restore();
      restoreProto();
    }
  });

  it("nonmatching callback and Submittable calls retain their return contract", async () => {
    const restoreProto = installQuery(function (this: Client, ...args: unknown[]) {
      const first = args[0];
      if (first && typeof first === "object" && typeof (first as { submit?: unknown }).submit === "function") {
        return first;
      }
      if (typeof args[args.length - 1] === "function") return undefined;
      return 42;
    });
    const delay = delayFirstQuery({ table: "listing_imports", value: "token-1", ms: 500 });
    try {
      const client = new Client({ connectionString: "postgres://127.0.0.1:9/none" });
      expect(client.query("SELECT 1")).toBe(42);
      const callback = () => undefined;
      const callbackResult = client.query(
        "SELECT id FROM listing_imports WHERE id = $1",
        ["token-1"],
        callback,
      );
      expect(callbackResult).toBeUndefined();
      expect(callbackResult).not.toBeInstanceOf(Promise);
      const submittable = { submit: () => undefined };
      expect(client.query(submittable as never)).toBe(submittable);
      expect(delay.fired()).toBe(false);
    } finally {
      await delay.restore();
      restoreProto();
    }
  });

  it("restore drains delayed work and restores query after an error", async () => {
    let calls = 0;
    let rejectDriver: (err: Error) => void = () => undefined;
    const restoreProto = installQuery(function () {
      calls += 1;
      if (calls === 1) {
        return new Promise((_, reject) => {
          rejectDriver = reject;
        });
      }
      return Promise.reject(new Error("driver down"));
    });
    const delay = delayFirstQuery({ table: "listing_imports", value: "token-1", ms: 15 });
    try {
      const client = new Client({ connectionString: "postgres://127.0.0.1:9/none" });
      const config = {
        text: "SELECT id FROM listing_imports WHERE id = $1",
        values: ["token-1"],
        rowMode: "array" as const,
        types: { getTypeParser: () => null },
      };
      const pending = client.query(config);
      const restored = delay.restore();
      let restoreDone = false;
      void restored.then(() => {
        restoreDone = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(calls).toBe(1);
      expect(restoreDone).toBe(false);
      rejectDriver(new Error("driver down"));
      await expect(pending).rejects.toThrow("driver down");
      await expect(restored).resolves.toBeUndefined();
      expect(restoreDone).toBe(true);
      const started = Date.now();
      await expect(client.query(config)).rejects.toThrow("driver down");
      expect(Date.now() - started).toBeLessThan(30);
      expect(calls).toBe(2);
    } finally {
      await delay.restore();
      restoreProto();
    }
  });

  it("rollback failure still settles commits and the original error remains", async () => {
    const reason = new Error("timed out: both queued");
    let rollbacks = 0;
    const hold = {
      pid: 1,
      commit: async () => undefined,
      rollback: async () => {
        rollbacks += 1;
        throw new Error("rollback failed");
      },
    };
    let finishFirst: (value: string) => void = () => undefined;
    let finishSecond: (err: Error) => void = () => undefined;
    const first = new Promise<string>((resolve) => {
      finishFirst = resolve;
    });
    const second = new Promise<never>((_, reject) => {
      finishSecond = reject;
    });
    void second.catch(() => undefined);
    let cleanupDone = false;
    const cleanup = abandonHeldCommits(hold, [first, second]).then(() => {
      cleanupDone = true;
    });
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    await flush();
    expect(rollbacks).toBe(1);
    expect(cleanupDone).toBe(false);
    finishFirst("kept");
    await flush();
    expect(cleanupDone).toBe(false);
    finishSecond(new Error("second failed"));
    await expect(cleanup.then(() => {
      throw reason;
    })).rejects.toBe(reason);
    expect(cleanupDone).toBe(true);
    await expect(first).resolves.toBe("kept");
    await expect(second).rejects.toThrow("second failed");
  });

  it("missing-store holder and repeated cleanup leave no connection behind", async () => {
    const ended: string[] = [];
    const queries: string[] = [];
    const client = {
      connect: async () => undefined,
      query: async (text: string) => {
        queries.push(text);
        if (text === "BEGIN") return { rowCount: 0, rows: [] };
        if (text.startsWith("SELECT 1")) return { rowCount: 0, rows: [] };
        if (text.includes("pg_backend_pid")) return { rowCount: 1, rows: [{ pid: 0 }] };
        return { rowCount: 0, rows: [] };
      },
      end: async () => {
        ended.push("end");
      },
      on: () => undefined,
    };
    await expect(holdStoreRow("missing-store", {
      createClient: () => client,
    })).rejects.toThrow("store row not locked");
    expect(ended).toEqual(["end"]);
    expect(queries.some((text) => text.startsWith("SELECT 1"))).toBe(true);

    ended.length = 0;
    queries.length = 0;
    await expect(holdStoreRow("begin-fails", {
      createClient: () => ({
        connect: async () => undefined,
        query: async (text: string) => {
          queries.push(text);
          if (text === "BEGIN") throw new Error("begin failed");
          return { rowCount: 0, rows: [] };
        },
        end: async () => {
          ended.push("end");
        },
        on: () => undefined,
      }),
    })).rejects.toThrow("begin failed");
    expect(ended).toEqual(["end"]);

    ended.length = 0;
    await expect(holdStoreRow("pid-fails", {
      createClient: () => ({
        connect: async () => undefined,
        query: async (text: string) => {
          if (text.includes("pg_backend_pid")) return { rowCount: 1, rows: [{ pid: 0 }] };
          if (text.startsWith("SELECT 1")) return { rowCount: 1, rows: [{}] };
          return { rowCount: 0, rows: [] };
        },
        end: async () => {
          ended.push("end");
        },
        on: () => undefined,
      }),
    })).rejects.toThrow("store row not locked");
    expect(ended).toEqual(["end"]);

    let ends = 0;
    const held = await holdStoreRow("held-store", {
      createClient: () => ({
        connect: async () => undefined,
        query: async (text: string) => {
          if (text.includes("pg_backend_pid")) return { rowCount: 1, rows: [{ pid: 42 }] };
          if (text.startsWith("SELECT 1")) return { rowCount: 1, rows: [{}] };
          return { rowCount: 0, rows: [] };
        },
        end: async () => {
          ends += 1;
        },
        on: () => undefined,
      }),
    });
    await held.rollback();
    await held.rollback();
    await held.commit();
    expect(ends).toBe(1);
    expect(held.pid).toBe(42);
  });

  it("direct URL alternatives and isolated runtime env matrix retain their contracts", async () => {
    const lane = "postgres://app_owner:pw@127.0.0.1:5434/lane_t219";
    const env = (values: Record<string, string | undefined>): NodeJS.ProcessEnv => ({
      NODE_ENV: "test",
      ...values,
    });
    expect(directUrlForLane(env({
      DATABASE_URL: lane,
      DATABASE_URL_UNPOOLED: lane,
    }))).toBe(lane);
    expect(directUrlForLane(env({
      DATABASE_URL: lane,
      DATABASE_URL_UNPOOLED: "  ",
      DIRECT_URL: lane,
    }))).toBe(lane);
    expect(() => directUrlForLane(env({ DATABASE_URL: lane }))).toThrow(
      /Neither DATABASE_URL_UNPOOLED nor DIRECT_URL/,
    );
    expect(() => directUrlForLane(env({
      DATABASE_URL: lane,
      DATABASE_URL_UNPOOLED: "postgres://app_owner:pw@203.0.113.5:5432/other",
      DIRECT_URL: lane,
    }))).toThrow("direct URL does not target the lane database");

    const withPassword = runtimeDatabaseUrl({ DATABASE_URL: lane, APP_RUNTIME_PASSWORD: "one" });
    const withOther = runtimeDatabaseUrl({ DATABASE_URL: lane, APP_RUNTIME_PASSWORD: "two" });
    expect(new URL(withPassword).username).toBe("app_runtime");
    expect(new URL(withPassword).password).toBe("one");
    expect(withOther).not.toBe(withPassword);
    expect(() => runtimeDatabaseUrl({
      DATABASE_URL: lane,
      NODE_ENV: "production",
      VERCEL: "1",
    })).toThrow(/APP_RUNTIME_PASSWORD is required in production/);
    expect(runtimeDatabaseUrl({
      DATABASE_URL: lane,
      NODE_ENV: "production",
      VERCEL: "1",
      NEXT_PHASE: "phase-production-build",
    })).toBe(lane);

    remember("DATABASE_URL_UNPOOLED");
    process.env.DATABASE_URL_UNPOOLED = "postgres://app_owner:pw@203.0.113.5:5432/other";
    const createClient = vi.fn();
    await expect(holdStoreRow("stale", { createClient })).rejects.toThrow(
      "direct URL does not target the lane database",
    );
    expect(createClient).not.toHaveBeenCalled();

    remember("DIRECT_URL");
    delete process.env.DATABASE_URL_UNPOOLED;
    delete process.env.DIRECT_URL;
    const connect = vi.spyOn(Client.prototype, "connect").mockRejectedValue(new Error("should not connect"));
    await expect(holdStoreRow("no-direct")).rejects.toThrow(/Neither DATABASE_URL_UNPOOLED nor DIRECT_URL/);
    expect(connect).not.toHaveBeenCalled();
    connect.mockRestore();
  });

  it("app code does not import the import lock test helper", () => {
    const root = join(process.cwd(), "src");
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
        if (entry.endsWith(".test.ts") || entry === "import-lock-test-helpers.ts") continue;
        const source = readFileSync(full, "utf8");
        if (source.includes("import-lock-test-helpers")) importers.push(full);
      }
    };
    walk(root);
    expect(importers).toEqual([]);
  });

  describe("pg callback form", () => {
    it("config callback is forwarded at once, returns undefined, and leaves the delay unfired", async () => {
      const client = await endedClient();
      const spy = installCallThrough();
      const delay = delayFirstQuery({ table: "listing_imports", value: "token", ms: 200 });
      const callback = trackedCallback("config");
      const config = listingConfig(["token"], { callback: callback.fn });
      try {
        const started = Date.now();
        const result = queryAs(client, config);
        expect(result).toBeUndefined();
        expect(result).not.toBeInstanceOf(Promise);
        expect(delay.fired()).toBe(false);
        expect(spy.seen).toHaveLength(1);
        expect(spy.seen[0]?.self).toBe(client);
        expect(spy.seen[0]?.args).toEqual([config]);
        expect(spy.seen[0]?.args[0]).toBe(config);
        expectDriverError(await awaitCallback(callback.done, "config"));
        expect(Date.now() - started).toBeLessThan(150);
        expect(delay.fired()).toBe(false);
      } finally {
        await delay.restore();
        spy.restore();
        await client.end().catch(() => undefined);
      }
    });

    it("a later promise query still takes the one-shot delay after a config callback", async () => {
      const client = await endedClient();
      const spy = installCallThrough();
      const delay = delayFirstQuery({ table: "listing_imports", value: "token", ms: 80 });
      const callback = trackedCallback("config");
      const callbackConfig = listingConfig(["token"], { callback: callback.fn });
      const promiseConfig = listingConfig(["token"]);
      try {
        expect(queryAs(client, callbackConfig)).toBeUndefined();
        expectDriverError(await awaitCallback(callback.done, "config"));
        expect(delay.fired()).toBe(false);
        const started = Date.now();
        const pending = queryAs(client, promiseConfig);
        expect(pending).toBeInstanceOf(Promise);
        const rejection = expectClosedClient(pending);
        expect(delay.fired()).toBe(true);
        expect(spy.seen.filter((row) => row.args[0] === promiseConfig)).toHaveLength(0);
        await rejection;
        const forwarded = spy.seen.filter((row) => row.args[0] === promiseConfig);
        expect(forwarded).toHaveLength(1);
        expect(forwarded[0]?.self).toBe(client);
        expect(forwarded[0]?.args[0]).toBe(promiseConfig);
        expect(forwarded[0]!.at - started).toBeGreaterThanOrEqual(60);
        expect(delay.fired()).toBe(true);
      } finally {
        await delay.restore();
        spy.restore();
        await client.end().catch(() => undefined);
      }
    });

    it("inherited config callback is treated as callback form", async () => {
      const client = await endedClient();
      const spy = installCallThrough();
      const delay = delayFirstQuery({ table: "listing_imports", value: "token", ms: 200 });
      const callback = trackedCallback("inherited");
      const config = Object.assign(Object.create({ callback: callback.fn }), {
        text: LISTING_SQL,
        values: ["token"],
      });
      try {
        expect(Object.hasOwn(config, "callback")).toBe(false);
        const result = queryAs(client, config);
        expect(result).toBeUndefined();
        expect(spy.seen[0]?.args[0]).toBe(config);
        expectDriverError(await awaitCallback(callback.done, "inherited"));
        expect(delay.fired()).toBe(false);
      } finally {
        await delay.restore();
        spy.restore();
        await client.end().catch(() => undefined);
      }
    });

    it("second-argument callback with a trailing undefined is forwarded at once", async () => {
      const client = await endedClient();
      const spy = installCallThrough();
      const delay = delayFirstQuery({ table: "listing_imports", value: "token", ms: 200 });
      const callback = trackedCallback("second");
      const config = listingConfig(["token"]);
      try {
        const result = queryAs(client, config, callback.fn, undefined);
        expect(result).toBeUndefined();
        expect(spy.seen[0]?.self).toBe(client);
        expect(spy.seen[0]?.args).toHaveLength(3);
        expect(spy.seen[0]?.args[0]).toBe(config);
        expect(spy.seen[0]?.args[1]).toBe(callback.fn);
        expect(spy.seen[0]?.args[2]).toBeUndefined();
        expectDriverError(await awaitCallback(callback.done, "second"));
        expect(delay.fired()).toBe(false);
      } finally {
        await delay.restore();
        spy.restore();
        await client.end().catch(() => undefined);
      }
    });

    it("non-function config callback throws pg's TypeError synchronously", async () => {
      const client = await endedClient();
      const spy = installCallThrough();
      const delay = delayFirstQuery({ table: "listing_imports", value: "token", ms: 200 });
      const callback = trackedCallback("should-not-run");
      try {
        const config = listingConfig(["token"], { callback: "x" });
        expect(spy.seen).toHaveLength(0);
        expect(() => queryAs(client, config)).toThrow(TypeError);
        expect(() => queryAs(client, config)).toThrow("callback is not a function");
        expect(spy.seen).toHaveLength(2);
        expect(spy.seen[0]?.args[0]).toBe(config);
        expect(() => queryAs(client, listingConfig(["token"], { callback: callback.fn }), ["token"], "x")).toThrow(
          "callback is not a function",
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(callback.calls).toEqual([]);
        expect(delay.fired()).toBe(false);
      } finally {
        await delay.restore();
        spy.restore();
        await client.end().catch(() => undefined);
      }
    });

    it("null or false callback stays promise form and is delayed", async () => {
      const client = await endedClient();
      const spy = installCallThrough();
      const delays = [0, 1, 2].map(() => delayFirstQuery({ table: "listing_imports", value: "token", ms: 80 }));
      const nullConfig = listingConfig(["token"], { callback: null });
      const falseConfig = listingConfig(["token"], { callback: false });
      const positionalValues = ["token"];
      try {
        const started = Date.now();
        const pending = [
          queryAs(client, nullConfig),
          queryAs(client, falseConfig),
          queryAs(client, LISTING_SQL, positionalValues, null),
        ];
        for (const result of pending) expect(result).toBeInstanceOf(Promise);
        const rejections = pending.map((result) => expectClosedClient(result));
        expect(delays.map((delay) => delay.fired())).toEqual([true, true, true]);
        expect(spy.seen).toHaveLength(0);
        await Promise.all(rejections);
        expect(spy.seen.map((row) => row.args[0])).toEqual([nullConfig, falseConfig, LISTING_SQL]);
        expect(spy.seen[2]?.args[1]).toBe(positionalValues);
        expect(spy.seen[2]?.args[2]).toBeNull();
        for (const row of spy.seen) {
          expect(row.self).toBe(client);
          expect(row.at - started).toBeGreaterThanOrEqual(60);
        }
        for (const delay of delays) expect(delay.fired()).toBe(true);
      } finally {
        await Promise.all(delays.map((delay) => delay.restore()));
        spy.restore();
        await client.end().catch(() => undefined);
      }
    });

    it("real Submittable and positional callback keep their driver return values", async () => {
      const client = await endedClient();
      const spy = installCallThrough();
      const delay = delayFirstQuery({ table: "listing_imports", value: "token", ms: 200 });
      const callback = trackedCallback("positional");
      const positionalValues = ["token"];
      const submittable = new Query(LISTING_SQL, ["token"]);
      const errors: Error[] = [];
      const errorSeen = new Promise<Error>((resolve) => {
        submittable.on("error", (err) => {
          errors.push(err);
          resolve(err);
        });
      });
      try {
        const positional = queryAs(client, LISTING_SQL, positionalValues, callback.fn);
        expect(positional).toBeUndefined();
        expect(spy.seen[0]?.args[2]).toBe(callback.fn);
        expectDriverError(await awaitCallback(callback.done, "positional"));
        const returned = client.query(submittable);
        expect(returned).toBe(submittable);
        expect(delay.fired()).toBe(false);
        const err = await Promise.race([
          errorSeen,
          new Promise<Error>((_, reject) => setTimeout(() => reject(new Error("submittable error missing")), 500)),
        ]);
        expect(err.message).toBe(CLOSED_CLIENT);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(errors).toHaveLength(1);
        expect(delay.fired()).toBe(false);
      } finally {
        await delay.restore();
        spy.restore();
        await client.end().catch(() => undefined);
      }
    });

    it("null query still reaches pg's own TypeError", async () => {
      const client = await endedClient();
      const spy = installCallThrough();
      const delay = delayFirstQuery({ table: "listing_imports", value: "token", ms: 200 });
      try {
        expect(() => queryAs(client, null)).toThrow(TypeError);
        expect(() => queryAs(client, null)).toThrow("Client was passed a null or undefined query");
        expect(() => queryAs(client, undefined)).toThrow("Client was passed a null or undefined query");
        expect(delay.fired()).toBe(false);
        expect(spy.seen.map((row) => row.args[0])).toEqual([null, null, undefined]);
      } finally {
        await delay.restore();
        spy.restore();
        await client.end().catch(() => undefined);
      }
    });

    it("callback calls do not consume either of two stacked rules", async () => {
      const client = await endedClient();
      const spy = installCallThrough();
      const first = delayFirstQuery({ table: "listing_imports", value: "token", ms: 80 });
      const second = delayFirstQuery({ table: "listing_imports", value: "token", ms: 80 });
      const callback = trackedCallback("stacked");
      const callbackConfig = listingConfig(["token"], { callback: callback.fn });
      const firstConfig = listingConfig(["token"]);
      const secondConfig = listingConfig(["token"]);
      try {
        expect(queryAs(client, callbackConfig)).toBeUndefined();
        expectDriverError(await awaitCallback(callback.done, "stacked"));
        expect(first.fired()).toBe(false);
        expect(second.fired()).toBe(false);
        const started = Date.now();
        const pendingFirst = queryAs(client, firstConfig);
        expect(pendingFirst).toBeInstanceOf(Promise);
        const firstRejection = expectClosedClient(pendingFirst);
        expect(first.fired()).toBe(true);
        expect(second.fired()).toBe(false);
        expect(queryAs(client, callbackConfig)).toBeUndefined();
        expect(second.fired()).toBe(false);
        const pendingSecond = queryAs(client, secondConfig);
        const secondRejection = expectClosedClient(pendingSecond);
        expect(second.fired()).toBe(true);
        expect(spy.seen.filter((row) => row.args[0] === firstConfig || row.args[0] === secondConfig)).toHaveLength(0);
        await Promise.all([firstRejection, secondRejection]);
        const forwarded = spy.seen.filter((row) => row.args[0] === firstConfig || row.args[0] === secondConfig);
        expect(forwarded.map((row) => row.args[0])).toEqual([firstConfig, secondConfig]);
        for (const row of forwarded) expect(row.at - started).toBeGreaterThanOrEqual(60);
      } finally {
        await first.restore();
        await second.restore();
        spy.restore();
        await client.end().catch(() => undefined);
      }
    });

    it("callback call is not held behind a pending delayed query", async () => {
      const client = await endedClient();
      const spy = installCallThrough();
      const delay = delayFirstQuery({ table: "listing_imports", value: "token", ms: 80 });
      const stillOpen = delayFirstQuery({ table: "listing_imports", value: "token", ms: 80 });
      const promiseConfig = listingConfig(["token"]);
      const callback = trackedCallback("interleaved");
      const callbackConfig = listingConfig(["token"], { callback: callback.fn });
      try {
        const started = Date.now();
        const pending = queryAs(client, promiseConfig);
        expect(pending).toBeInstanceOf(Promise);
        const rejection = expectClosedClient(pending);
        expect(delay.fired()).toBe(true);
        expect(stillOpen.fired()).toBe(false);
        expect(spy.seen).toHaveLength(0);
        expect(queryAs(client, callbackConfig)).toBeUndefined();
        expect(stillOpen.fired()).toBe(false);
        expect(spy.seen).toHaveLength(1);
        expect(spy.seen[0]?.self).toBe(client);
        expect(spy.seen[0]?.args[0]).toBe(callbackConfig);
        expect(spy.seen[0]!.at - started).toBeLessThan(40);
        expectDriverError(await awaitCallback(callback.done, "interleaved"));
        expect(spy.seen.filter((row) => row.args[0] === promiseConfig)).toHaveLength(0);
        await rejection;
        expect(spy.seen.map((row) => row.args[0])).toEqual([callbackConfig, promiseConfig]);
        expect(spy.seen[1]!.at - started).toBeGreaterThanOrEqual(60);
        expect(stillOpen.fired()).toBe(false);
        const laterConfig = listingConfig(["token"]);
        const later = queryAs(client, laterConfig);
        expect(later).toBeInstanceOf(Promise);
        const laterRejection = expectClosedClient(later);
        expect(stillOpen.fired()).toBe(true);
        await laterRejection;
      } finally {
        await delay.restore();
        await stillOpen.restore();
        spy.restore();
        await client.end().catch(() => undefined);
      }
    });

    it("restore after callback-only calls is immediate and reinstalls native query", async () => {
      const client = await endedClient();
      const spy = installCallThrough();
      const delay = delayFirstQuery({ table: "listing_imports", value: "token", ms: 200 });
      const callback = trackedCallback("restore");
      try {
        expect(proto.query).not.toBe(spy.wrapped);
        const started = Date.now();
        expect(queryAs(client, listingConfig(["token"], { callback: callback.fn }))).toBeUndefined();
        expectDriverError(await awaitCallback(callback.done, "restore"));
        expect(delay.fired()).toBe(false);
        await delay.restore();
        expect(Date.now() - started).toBeLessThan(150);
        expect(proto.query).toBe(spy.wrapped);
      } finally {
        if (proto.query !== spy.wrapped) await delay.restore();
        spy.restore();
        await client.end().catch(() => undefined);
      }
    });

    it("callback accessors preserve native clone receiver and observation count", async () => {
      const client = await endedClient();
      const spy = installCallThrough();
      try {
        for (const kind of ["own", "inherited"] as const) {
          const native = receiverCallbackConfig(kind);
          expect(queryAs(client, native.config)).toBeUndefined();
          expect(await awaitCallback(native.done, kind)).toBe(CLOSED_CLIENT);
          const first = delayFirstQuery({ table: "listing_imports", value: "token", ms: 80 });
          const second = delayFirstQuery({ table: "listing_imports", value: "other", ms: 80 });
          const patched = receiverCallbackConfig(kind);
          try {
            const mark = spy.seen.length;
            expect(queryAs(client, patched.config)).toBeUndefined();
            expect(await awaitCallback(patched.done, kind)).toBe(CLOSED_CLIENT);
            expect(patched.observations()).toBe(native.observations());
            expect(patched.receivers).toHaveLength(native.receivers.length);
            expect(native.receivers.every((receiver) => receiver !== native.config)).toBe(true);
            expect(patched.receivers.every((receiver) => receiver !== patched.config)).toBe(true);
            expect(first.fired()).toBe(false);
            expect(second.fired()).toBe(false);
            expect(spy.seen[mark]?.args[0]).toBe(patched.config);
            const promiseConfig = listingConfig(["token"]);
            const started = Date.now();
            const pending = queryAs(client, promiseConfig);
            expect(pending).toBeInstanceOf(Promise);
            const rejection = expectClosedClient(pending);
            expect(first.fired()).toBe(true);
            expect(second.fired()).toBe(false);
            expect(spy.seen.filter((row) => row.args[0] === promiseConfig)).toHaveLength(0);
            await rejection;
            const forwarded = spy.seen.find((row) => row.args[0] === promiseConfig);
            expect(forwarded?.at).toBeGreaterThanOrEqual(started + 60);
          } finally {
            await first.restore();
            await second.restore();
          }
        }
        let sets = 0;
        const setterConfig = listingConfig(["token"]);
        Object.defineProperty(setterConfig, "callback", {
          configurable: true,
          enumerable: true,
          set() {
            sets += 1;
          },
        });
        const nativeResult = queryAs(client, setterConfig);
        expect(nativeResult).toBeInstanceOf(Promise);
        const nativeRejection = expectClosedClient(nativeResult);
        const nativeSets = sets;
        await nativeRejection;
        const held = delayFirstQuery({ table: "listing_imports", value: "token", ms: 200 });
        try {
          const started = Date.now();
          const patched = queryAs(client, setterConfig);
          expect(patched).toBeInstanceOf(Promise);
          const patchedRejection = expectClosedClient(patched);
          expect(held.fired()).toBe(false);
          expect(sets).toBe(nativeSets);
          await patchedRejection;
          expect(Date.now() - started).toBeLessThan(150);
          expect(held.fired()).toBe(false);
        } finally {
          await held.restore();
        }
      } finally {
        spy.restore();
        await client.end().catch(() => undefined);
      }
    });

    it("non-enumerable and null-prototype callbacks bypass the delay", async () => {
      const client = await endedClient();
      const spy = installCallThrough();
      const delay = delayFirstQuery({ table: "listing_imports", value: "token", ms: 200 });
      const hidden = trackedCallback("hidden");
      const bare = trackedCallback("bare");
      const hiddenConfig = listingConfig(["token"]);
      Object.defineProperty(hiddenConfig, "callback", {
        value: hidden.fn,
        enumerable: false,
        writable: true,
        configurable: true,
      });
      const bareConfig = Object.assign(Object.create(null), { text: LISTING_SQL, values: ["token"] });
      Object.defineProperty(bareConfig, "callback", {
        value: bare.fn,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      try {
        expect(Object.keys(hiddenConfig)).not.toContain("callback");
        expect(Object.getPrototypeOf(bareConfig)).toBeNull();
        expect(queryAs(client, hiddenConfig)).toBeUndefined();
        expect(queryAs(client, bareConfig)).toBeUndefined();
        expectDriverError(await awaitCallback(hidden.done, "hidden"));
        expectDriverError(await awaitCallback(bare.done, "bare"));
        expect(spy.seen.map((row) => row.args[0])).toEqual([hiddenConfig, bareConfig]);
        expect(delay.fired()).toBe(false);
      } finally {
        await delay.restore();
        spy.restore();
        await client.end().catch(() => undefined);
      }
    });

    it("callback precedence follows only the first three driver arguments", async () => {
      const client = await endedClient();
      const spy = installCallThrough();
      const delay = delayFirstQuery({ table: "listing_imports", value: "token", ms: 80 });
      try {
        const winner = trackedCallback("third");
        const loserA = trackedCallback("config");
        const loserB = trackedCallback("second");
        const config = listingConfig(["token"], { callback: loserA.fn });
        expect(queryAs(client, config, loserB.fn, winner.fn)).toBeUndefined();
        expectDriverError(await awaitCallback(winner.done, "third"));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(loserA.calls).toEqual([]);
        expect(loserB.calls).toEqual([]);
        expect(delay.fired()).toBe(false);

        const invalidA = trackedCallback("invalid-config");
        const invalidB = trackedCallback("invalid-second");
        expect(() => queryAs(
          client,
          listingConfig(["token"], { callback: invalidA.fn }),
          invalidB.fn,
          "x",
        )).toThrow("callback is not a function");
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(invalidA.calls).toEqual([]);
        expect(invalidB.calls).toEqual([]);
        expect(delay.fired()).toBe(false);

        for (const third of [null, undefined, false]) {
          const configCallback = trackedCallback("fallback-config");
          const secondCallback = trackedCallback("fallback-second");
          expect(queryAs(
            client,
            listingConfig(["token"], { callback: configCallback.fn }),
            secondCallback.fn,
            third,
          )).toBeUndefined();
          expectDriverError(await awaitCallback(secondCallback.done, "fallback-second"));
          await new Promise((resolve) => setTimeout(resolve, 15));
          expect(configCallback.calls).toEqual([]);
        }
        expect(delay.fired()).toBe(false);

        const ignored = trackedCallback("fourth");
        const promiseConfig = listingConfig(["token"]);
        const started = Date.now();
        const pending = queryAs(client, promiseConfig, undefined, undefined, ignored.fn);
        expect(pending).toBeInstanceOf(Promise);
        const rejection = expectClosedClient(pending);
        expect(delay.fired()).toBe(true);
        expect(spy.seen.filter((row) => row.args[0] === promiseConfig)).toHaveLength(0);
        await rejection;
        const forwarded = spy.seen.find((row) => row.args[0] === promiseConfig);
        expect(forwarded?.args).toHaveLength(4);
        expect(forwarded?.args[3]).toBe(ignored.fn);
        expect(forwarded!.at - started).toBeGreaterThanOrEqual(60);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(ignored.calls).toEqual([]);
      } finally {
        await delay.restore();
        spy.restore();
        await client.end().catch(() => undefined);
      }
    });

    it("callback overrides preserve native synchronous normalization errors", async () => {
      const client = await endedClient();
      const samples = [
        () => {
          const calls: string[] = [];
          const config = listingConfig(["token"]);
          Object.defineProperty(config, "callback", {
            value: () => calls.push("own"),
            writable: false,
            enumerable: true,
            configurable: true,
          });
          return { config, calls, gets: () => 0 };
        },
        () => {
          const calls: string[] = [];
          let gets = 0;
          const config = listingConfig(["token"]);
          Object.defineProperty(config, "callback", {
            configurable: true,
            enumerable: true,
            get() {
              gets += 1;
              return () => calls.push("getter");
            },
          });
          return { config, calls, gets: () => gets };
        },
        () => {
          const calls: string[] = [];
          const proto = {};
          Object.defineProperty(proto, "callback", {
            value: () => calls.push("inherited"),
            writable: false,
            enumerable: true,
            configurable: true,
          });
          const config = Object.assign(Object.create(proto), { text: LISTING_SQL, values: ["token"] });
          return { config, calls, gets: () => 0 };
        },
      ];
      const baselines: Error[] = [];
      for (const sample of samples) {
        const made = sample();
        const override = () => undefined;
        try {
          queryAs(client, made.config, override);
          throw new Error("native override should throw");
        } catch (err) {
          baselines.push(err as Error);
        }
        expect(made.calls).toEqual([]);
      }
      const spy = installCallThrough();
      const delay = delayFirstQuery({ table: "listing_imports", value: "token", ms: 80 });
      try {
        for (const [index, sample] of samples.entries()) {
          const made = sample();
          const beforeGets = made.gets();
          let thrown: unknown;
          try {
            queryAs(client, made.config, () => undefined);
          } catch (err) {
            thrown = err;
          }
          expect(thrown).toBeInstanceOf(baselines[index]!.constructor);
          expect((thrown as Error).message).toBe(baselines[index]!.message);
          expect(made.calls).toEqual([]);
          expect(made.gets()).toBe(beforeGets);
          expect(delay.fired()).toBe(false);
        }
        const promiseConfig = listingConfig(["token"]);
        const started = Date.now();
        const pending = queryAs(client, promiseConfig);
        expect(pending).toBeInstanceOf(Promise);
        const rejection = expectClosedClient(pending);
        expect(delay.fired()).toBe(true);
        expect(spy.seen.filter((row) => row.args[0] === promiseConfig)).toHaveLength(0);
        await rejection;
        const forwarded = spy.seen.find((row) => row.args[0] === promiseConfig);
        expect(forwarded?.at).toBeGreaterThanOrEqual(started + 60);
      } finally {
        await delay.restore();
        spy.restore();
        await client.end().catch(() => undefined);
      }
    });

    it("callbacks on another client bypass pending work and partial restore preserves remaining rules", async () => {
      const clientA = await endedClient();
      const clientB = await endedClient();
      const spy = installCallThrough();
      const delayA = delayFirstQuery({ table: "listing_imports", value: "token-a", ms: 80 });
      const delayB = delayFirstQuery({ table: "listing_imports", value: "token-b", ms: 80 });
      const callback = trackedCallback("other");
      const promiseConfig = listingConfig(["token-a"]);
      const callbackConfig = listingConfig(["token-b"], { callback: callback.fn });
      try {
        const started = Date.now();
        const pending = queryAs(clientA, promiseConfig);
        expect(pending).toBeInstanceOf(Promise);
        const rejection = expectClosedClient(pending);
        expect(delayA.fired()).toBe(true);
        expect(spy.seen).toHaveLength(0);
        expect(queryAs(clientB, callbackConfig)).toBeUndefined();
        expect(delayB.fired()).toBe(false);
        expect(spy.seen).toHaveLength(1);
        expect(spy.seen[0]?.self).toBe(clientB);
        expect(spy.seen[0]?.args).toEqual([callbackConfig]);
        expectDriverError(await awaitCallback(callback.done, "other"));
        expect(spy.seen.filter((row) => row.self === clientA)).toHaveLength(0);
        await rejection;
        const forwarded = spy.seen.find((row) => row.args[0] === promiseConfig);
        expect(forwarded?.self).toBe(clientA);
        expect(forwarded!.at - started).toBeGreaterThanOrEqual(60);
        const wrapped = proto.query;
        expect(wrapped).not.toBe(spy.wrapped);
        await delayA.restore();
        expect(proto.query).toBe(wrapped);
        expect(delayB.fired()).toBe(false);
        const laterConfig = listingConfig(["token-b"]);
        const laterStarted = Date.now();
        const later = queryAs(clientB, laterConfig);
        expect(later).toBeInstanceOf(Promise);
        const laterRejection = expectClosedClient(later);
        expect(delayB.fired()).toBe(true);
        expect(proto.query).toBe(wrapped);
        expect(spy.seen.filter((row) => row.args[0] === laterConfig)).toHaveLength(0);
        await laterRejection;
        const laterForwarded = spy.seen.find((row) => row.args[0] === laterConfig);
        expect(laterForwarded?.self).toBe(clientB);
        expect(laterForwarded!.at - laterStarted).toBeGreaterThanOrEqual(60);
        await delayB.restore();
        expect(proto.query).toBe(spy.wrapped);
      } finally {
        await delayA.restore();
        await delayB.restore();
        spy.restore();
        await clientA.end().catch(() => undefined);
        await clientB.end().catch(() => undefined);
      }
    });

    it("fired marks scheduling and only one same-turn promise call is delayed", async () => {
      const client = await endedClient();
      const spy = installCallThrough();
      const delay = delayFirstQuery({ table: "listing_imports", value: "token", ms: 80 });
      const first = listingConfig(["token"]);
      const second = listingConfig(["token"]);
      try {
        const started = Date.now();
        const pendingFirst = queryAs(client, first);
        expect(pendingFirst).toBeInstanceOf(Promise);
        const firstRejection = expectClosedClient(pendingFirst);
        expect(delay.fired()).toBe(true);
        expect(spy.seen).toHaveLength(0);
        const pendingSecond = queryAs(client, second);
        expect(pendingSecond).toBeInstanceOf(Promise);
        const secondRejection = expectClosedClient(pendingSecond);
        expect(spy.seen).toHaveLength(1);
        expect(spy.seen[0]?.args[0]).toBe(second);
        expect(spy.seen[0]?.self).toBe(client);
        expect(spy.seen[0]!.at - started).toBeLessThan(40);
        await Promise.all([firstRejection, secondRejection]);
        expect(spy.seen.map((row) => row.args[0])).toEqual([second, first]);
        expect(spy.seen[1]!.at - started).toBeGreaterThanOrEqual(60);
        expect(spy.seen[0]!.at).toBeLessThan(spy.seen[1]!.at);
        expect(delay.fired()).toBe(true);
      } finally {
        await delay.restore();
        spy.restore();
        await client.end().catch(() => undefined);
      }
    });

    it("real Query returns by identity and delivers its native error before cleanup", async () => {
      const client = await endedClient();
      const spy = installCallThrough();
      const delay = delayFirstQuery({ table: "listing_imports", value: "token", ms: 200 });
      const submittable = new Query(LISTING_SQL, ["token"]);
      const errors: Error[] = [];
      const errorSeen = new Promise<Error>((resolve) => {
        submittable.on("error", (err) => {
          errors.push(err);
          resolve(err);
        });
      });
      try {
        const returned = client.query(submittable);
        expect(returned).toBe(submittable);
        expect(spy.seen[0]?.self).toBe(client);
        expect(spy.seen[0]?.args[0]).toBe(submittable);
        expect(delay.fired()).toBe(false);
        const err = await Promise.race([
          errorSeen,
          new Promise<Error>((_, reject) => setTimeout(() => reject(new Error("query error missing")), 500)),
        ]);
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe(CLOSED_CLIENT);
        await delay.restore();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(errors).toEqual([err]);
        expect(delay.fired()).toBe(false);
        expect(proto.query).toBe(spy.wrapped);
      } finally {
        if (proto.query !== spy.wrapped) await delay.restore();
        spy.restore();
        await client.end().catch(() => undefined);
      }
    });

    it("callback bypass preserves config identity descriptors and original argument list", async () => {
      const client = await endedClient();
      const spy = installCallThrough();
      const delay = delayFirstQuery({ table: "listing_imports", value: "token", ms: 200 });
      const callback = trackedCallback("identity");
      const config = listingConfig(["token"], {
        callback: callback.fn,
        rowMode: "array",
        name: "listing_import_read",
      });
      const before = Object.getOwnPropertyDescriptors(config);
      const positionalValues = ["token"];
      const positional = trackedCallback("positional-identity");
      try {
        expect(queryAs(client, config)).toBeUndefined();
        expect(spy.seen[0]?.self).toBe(client);
        expect(spy.seen[0]?.args).toHaveLength(1);
        expect(spy.seen[0]?.args[0]).toBe(config);
        expect(Object.getOwnPropertyDescriptors(config)).toEqual(before);
        expect(queryAs(client, LISTING_SQL, positionalValues, positional.fn)).toBeUndefined();
        expect(spy.seen[1]?.args).toHaveLength(3);
        expect(spy.seen[1]?.args[0]).toBe(LISTING_SQL);
        expect(spy.seen[1]?.args[1]).toBe(positionalValues);
        expect(spy.seen[1]?.args[2]).toBe(positional.fn);
        expectDriverError(await awaitCallback(callback.done, "identity"));
        expectDriverError(await awaitCallback(positional.done, "positional-identity"));
        expect(Object.getOwnPropertyDescriptors(config)).toEqual(before);
        expect(delay.fired()).toBe(false);
      } finally {
        await delay.restore();
        spy.restore();
        await client.end().catch(() => undefined);
      }
    });
  });
});
