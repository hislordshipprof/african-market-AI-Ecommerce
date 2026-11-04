import { readdirSync, readFileSync, statSync } from "fs";
import { createServer, type AddressInfo, type Socket } from "net";
import { join } from "path";
import { Client } from "pg";
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
});
