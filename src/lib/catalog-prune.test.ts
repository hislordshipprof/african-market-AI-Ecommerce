import { DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import {
  CATALOG_PRUNE_MIN_AGE_MS,
  catalogPruneMode,
  planCatalogPrune,
  type DatabaseIdentity,
  type OwnershipBinding,
} from "./catalog-prune";
import { deleteCatalogCandidates, listCatalogObjects } from "./catalog-prune-execute";
import { createFakeR2 } from "./catalog-prune-fake-r2";
import { resolveDirectUrl } from "./env";
import { deleteDeliveryProof } from "./r2";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-15T12:00:00.000Z");
const BUCKET = "unit-bucket";
const SECRET = "sentinel-secret-value";
const ACCESS = "sentinel-access-value";

const r2Env = {
  R2_ACCOUNT_ID: "acct-sentinel",
  R2_ACCESS_KEY_ID: ACCESS,
  R2_SECRET_ACCESS_KEY: SECRET,
  R2_BUCKET: BUCKET,
};

const neonUrl = "postgresql://user:sentinel-secret-value@ep-test.neon.tech:5432/neondb";
const neon: DatabaseIdentity = { host: "ep-test.neon.tech", port: "5432", database: "neondb" };
const binding: OwnershipBinding[] = [
  { accountId: "acct-sentinel", bucket: BUCKET, databases: [{ host: neon.host, database: neon.database }] },
];

function age(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

function removeTemp(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`temp cleanup failed for ${dir}: ${message}`);
  }
}

/** One process, a deadline, and no wait on the event loop. stdout is kept; a timeout kills the child. */
function runBounded(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(stdout);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish();
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", finish);
    child.on("exit", finish);
  });
}

/** Git usr/bin next to bash.exe. ps.exe and kill.exe live there. */
function gitUsrBin(name: string): string {
  return path.join(path.dirname(gitBash()), name);
}

type ProcRow = { pid: number; ppid: number; winpid: number };

function parsePs(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const msysPid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const winpid = Number(parts[3]);
    if (!Number.isInteger(msysPid) || !Number.isInteger(ppid) || !Number.isInteger(winpid)) continue;
    rows.push({ pid: msysPid, ppid, winpid });
  }
  return rows;
}

/**
 * MSYS pids under the Windows processes we spawned, children before parents.
 * Node's pid is not a ps WINPID: MSYS exec keeps its own. The sleeps are not
 * Windows children of that pid either, so taskkill /T never sees them. The
 * direct Windows child's WINPID is the bash row, and its MSYS children are the tree.
 */
function msysKillOrder(rows: ProcRow[], windowsPids: number[]): number[] {
  const windows = new Set(windowsPids);
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const list = children.get(row.ppid);
    if (list) list.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
  const seen = new Set<number>();
  const order: number[] = [];
  const walk = (msysPid: number) => {
    if (seen.has(msysPid)) return;
    seen.add(msysPid);
    for (const kid of children.get(msysPid) ?? []) walk(kid);
    order.push(msysPid);
  };
  for (const row of rows) {
    if (windows.has(row.winpid)) walk(row.pid);
  }
  return order;
}

async function windowsChildPids(pid: number): Promise<number[]> {
  const listed = await runBounded("powershell.exe", [
    "-NoProfile",
    "-Command",
    `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}").ProcessId -join ' '`,
  ], 8_000);
  return listed.split(/\s+/).map(Number).filter((value) => Number.isInteger(value) && value > 0);
}

async function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    return;
  }
  const [listed, kids] = await Promise.all([
    runBounded(gitUsrBin("ps.exe"), ["-e"], 8_000),
    windowsChildPids(pid),
  ]);
  for (const msysPid of msysKillOrder(parsePs(listed), [pid, ...kids])) {
    await runBounded(gitUsrBin("kill.exe"), ["-KILL", String(msysPid)], 4_000);
  }
  await runBounded("taskkill", ["/PID", String(pid), "/T", "/F"], 8_000);
}

/** Async spawn. stdin is closed so a stub that reads it gets EOF. A timeout or the test's abort signal kills the process tree, then this waits for exit. */
function runCommand(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let stopped = false;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    let backup: ReturnType<typeof setTimeout> | undefined;
    const stop = async (why: string) => {
      if (settled || stopped) return;
      stopped = true;
      // Arm the failure before the kill. A hung taskkill still settles, with the same message.
      backup = setTimeout(() => finish(new Error(`${why} (${stderr})`)), 5_000);
      await killProcessTree(child);
    };
    const deadline = setTimeout(() => stop("timed out"), options.timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (backup) clearTimeout(backup);
      options.signal?.removeEventListener("abort", onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };
    // A listener never runs for a signal that is already aborted. Vitest reuses the
    // same task signal on retry, so reading .aborted here kills a healthy second attempt.
    const onAbort = () => stop("aborted");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      setImmediate(() => {
        if (code === 0 && !stopped) finish();
        else finish(new Error(`command failed (exit ${code ?? "null"}, signal ${signal ?? "null"}): ${stderr}`));
      });
    });
  });
}

/** Absolute Git bash, so Node can spawn it without depending on PATH order. */
let gitBashPath: string | undefined;
function gitBash(): string {
  if (gitBashPath) return gitBashPath;
  if (process.platform !== "win32") {
    gitBashPath = "bash";
    return gitBashPath;
  }
  const listed = spawnSync("where", ["bash"], { encoding: "utf8" }).stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  gitBashPath = listed.find((found) => /Git\\usr\\bin\\bash\.exe$/i.test(found)) ?? listed[0] ?? "bash";
  return gitBashPath;
}

/** Milliseconds left before the Vitest timeout, so this helper fires first. */
function commandBudget(startedAt: number, testMs: number): number {
  return Math.max(1_000, testMs - (Date.now() - startedAt) - 750);
}

describe("catalog prune guard and planner", () => {
  it("prune is off when SEED_PRUNE_R2 is unset or empty", () => {
    expect(catalogPruneMode({ env: {}, databaseUrl: neonUrl })).toEqual({ mode: "off" });
    expect(catalogPruneMode({ env: { SEED_PRUNE_R2: "" }, databaseUrl: neonUrl })).toEqual({ mode: "off" });
    expect(catalogPruneMode({ env: { SEED_PRUNE_R2: "   " }, databaseUrl: neonUrl })).toEqual({ mode: "off" });
  });

  it("refuses SEED_PRUNE_R2 values other than dry-run or the bucket name", () => {
    for (const value of ["1", "true", "yes", "other-bucket"]) {
      const decision = catalogPruneMode({
        env: { ...r2Env, SEED_PRUNE_R2: value },
        databaseUrl: neonUrl,
        observed: neon,
      });
      expect(decision).toEqual({
        refused: expect.stringContaining("Accepted forms: dry-run, or the R2_BUCKET value"),
      });
      expect(JSON.stringify(decision)).not.toContain(SECRET);
    }
  });

  it.each([
    ["CI", "true"],
    ["CI", "1"],
    ["VERCEL", "1"],
    ["NODE_ENV", "production"],
    ["VERCEL_ENV", "production"],
    ["VERCEL_ENV", "preview"],
    ["E2E_STORE_OVERRIDE", "1"],
  ])("refuses under CI=true, CI=1, VERCEL=1, NODE_ENV=production, VERCEL_ENV=production and any E2E_* key (%s=%s)", (key, value) => {
    const decision = catalogPruneMode({
      env: { ...r2Env, SEED_PRUNE_R2: "dry-run", [key]: value },
      databaseUrl: neonUrl,
      observed: neon,
    });
    expect("refused" in decision).toBe(true);
    if ("refused" in decision) expect(decision.refused).toContain(key === "E2E_STORE_OVERRIDE" ? "E2E_STORE_OVERRIDE" : key);
    expect(JSON.stringify(decision)).not.toContain(SECRET);
  });

  it("refuses localhost, 127.0.0.1, [::1] and lane_* databases; allows a Neon host", () => {
    const cases: Array<[string, string, string]> = [
      ["postgresql://u:p@localhost:5434/lane_t225", "localhost", "localhost"],
      ["postgresql://u:p@127.0.0.1:5432/dev", "127.0.0.1", "127.0.0.1"],
      ["postgresql://u:p@[::1]:5432/dev", "::1", "::1"],
      ["postgresql://u:p@ep-test.neon.tech:5432/lane_x", "lane_", "lane_"],
    ];
    for (const [url, needle] of cases) {
      const decision = catalogPruneMode({
        env: { ...r2Env, SEED_PRUNE_R2: "dry-run" },
        databaseUrl: url,
        observed: neon,
      });
      expect("refused" in decision && decision.refused.includes(needle)).toBe(true);
    }
    const dryRun = catalogPruneMode({
      env: { ...r2Env, SEED_PRUNE_R2: "dry-run" },
      databaseUrl: neonUrl,
      observed: neon,
    });
    expect(dryRun).toEqual({ mode: "dry-run" });
    const destructive = catalogPruneMode({
      env: { ...r2Env, SEED_PRUNE_R2: BUCKET },
      databaseUrl: neonUrl,
      observed: neon,
      ownership: [],
      writersCoordinated: true,
    });
    expect(destructive).toEqual({
      refused: expect.stringContaining("no authoritative ownership binding"),
    });
  });

  it("a remote dry-run accepts the connected server IP when DNS says it belongs to the URL host", async () => {
    const observed = { host: "10.0.0.1", port: "5432", database: "neondb" };
    const bare = catalogPruneMode({
      env: { ...r2Env, SEED_PRUNE_R2: "dry-run" },
      databaseUrl: neonUrl,
      observed,
    });
    expect(bare).toEqual({ refused: expect.stringContaining("does not match the connected database") });
    expect(catalogPruneMode({
      env: { ...r2Env, SEED_PRUNE_R2: "dry-run" },
      databaseUrl: neonUrl,
      observed,
      resolvedHosts: { "ep-test.neon.tech": ["10.0.0.1"] },
    })).toEqual({ mode: "dry-run" });
    expect(catalogPruneMode({
      env: { ...r2Env, SEED_PRUNE_R2: "dry-run" },
      databaseUrl: neonUrl,
      observed,
      resolvedHosts: { "ep-test.neon.tech": ["10.0.0.2"] },
    })).toEqual({ refused: expect.stringContaining("does not match the connected database") });
    const masked = { host: "10.0.0.1/32", port: "5432", database: "neondb" };
    expect(catalogPruneMode({
      env: { ...r2Env, SEED_PRUNE_R2: "dry-run" },
      databaseUrl: neonUrl,
      observed: masked,
      resolvedHosts: { "ep-test.neon.tech": ["10.0.0.1"] },
    })).toEqual({ mode: "dry-run" });
    expect(catalogPruneMode({
      env: { ...r2Env, SEED_PRUNE_R2: "dry-run" },
      databaseUrl: neonUrl,
      observed: { host: "::1/128", port: "5432", database: "neondb" },
      resolvedHosts: { "ep-test.neon.tech": ["::1"] },
    })).toEqual({ refused: expect.stringContaining("database host is ::1/128") });
    expect(catalogPruneMode({
      env: { ...r2Env, SEED_PRUNE_R2: "dry-run" },
      databaseUrl: neonUrl,
      observed: { host: "127.0.0.1/32", port: "5432", database: "neondb" },
      resolvedHosts: { "ep-test.neon.tech": ["127.0.0.1"] },
    })).toEqual({ refused: expect.stringContaining("database host is 127.0.0.1/32") });

    const savedUnpooled = process.env.DATABASE_URL_UNPOOLED;
    const savedDirect = process.env.DIRECT_URL;
    delete process.env.DATABASE_URL_UNPOOLED;
    process.env.DIRECT_URL = neonUrl;
    try {
      const { decideCliCatalogPrune } = await import("../../prisma/seed-master-catalog");
      const matched = await decideCliCatalogPrune(
        { ...r2Env, SEED_PRUNE_R2: "dry-run", NODE_ENV: "test" },
        async () => observed,
        async () => ["10.0.0.1"],
      );
      expect(matched).toEqual({ mode: "dry-run" });
      const missed = await decideCliCatalogPrune(
        { ...r2Env, SEED_PRUNE_R2: "dry-run", NODE_ENV: "test" },
        async () => observed,
        async () => ["10.9.9.9"],
      );
      expect(missed).toEqual({ refused: expect.stringContaining("does not match the connected database") });
      expect(JSON.stringify(missed)).not.toContain(SECRET);
    } finally {
      if (savedUnpooled === undefined) delete process.env.DATABASE_URL_UNPOOLED;
      else process.env.DATABASE_URL_UNPOOLED = savedUnpooled;
      if (savedDirect === undefined) delete process.env.DIRECT_URL;
      else process.env.DIRECT_URL = savedDirect;
    }
  });

  it("refusal names missing key names and never prints values", () => {
    const decision = catalogPruneMode({
      env: { ...r2Env, R2_SECRET_ACCESS_KEY: undefined, SEED_PRUNE_R2: "dry-run" },
      databaseUrl: neonUrl,
      observed: neon,
    });
    expect(decision).toEqual({ refused: expect.stringContaining("missing R2_SECRET_ACCESS_KEY") });
    expect(JSON.stringify(decision)).not.toContain(ACCESS);
    expect(JSON.stringify(decision)).not.toContain(SECRET);
  });

  it("effective direct connection must match authoritative bucket ownership", () => {
    const savedUnpooled = process.env.DATABASE_URL_UNPOOLED;
    const savedDirect = process.env.DIRECT_URL;
    process.env.DATABASE_URL_UNPOOLED = "postgresql://user:sentinel-secret-value@ep-other.neon.tech:5432/otherdb";
    process.env.DIRECT_URL = neonUrl;
    try {
      const resolved = resolveDirectUrl();
      expect(new URL(resolved).hostname).toBe("ep-other.neon.tech");
      const decision = catalogPruneMode({
        env: { ...r2Env, SEED_PRUNE_R2: BUCKET },
        databaseUrl: resolved,
        observed: neon,
        ownership: binding,
        writersCoordinated: true,
      });
      expect(decision).toEqual({
        refused: expect.stringContaining("does not match the connected database"),
      });
      expect(JSON.stringify(decision)).not.toContain(SECRET);
      const allowed = catalogPruneMode({
        env: { ...r2Env, SEED_PRUNE_R2: BUCKET },
        databaseUrl: neonUrl,
        observed: neon,
        ownership: binding,
        writersCoordinated: true,
      });
      expect(allowed).toEqual({ mode: "delete" });
      const shared = catalogPruneMode({
        env: { ...r2Env, SEED_PRUNE_R2: BUCKET },
        databaseUrl: neonUrl,
        observed: neon,
        ownership: [{
          accountId: "acct-sentinel",
          bucket: BUCKET,
          databases: [
            { host: neon.host, database: neon.database },
            { host: "ep-preview.neon.tech", database: "preview" },
          ],
        }],
        writersCoordinated: true,
      });
      expect(shared).toEqual({ refused: expect.stringContaining("more than one database") });
      const uncoordinated = catalogPruneMode({
        env: { ...r2Env, SEED_PRUNE_R2: BUCKET },
        databaseUrl: neonUrl,
        observed: neon,
        ownership: binding,
        writersCoordinated: false,
      });
      expect(uncoordinated).toEqual({
        refused: expect.stringContaining("catalog writers are not coordinated"),
      });
    } finally {
      if (savedUnpooled === undefined) delete process.env.DATABASE_URL_UNPOOLED;
      else process.env.DATABASE_URL_UNPOOLED = savedUnpooled;
      if (savedDirect === undefined) delete process.env.DIRECT_URL;
      else process.env.DIRECT_URL = savedDirect;
    }
  });

  it("plan keeps webp, referenced in every URL form, and objects younger than 24h", () => {
    const key = "catalog/a.jpg";
    const references = [
      key,
      `/api/catalog-image/${key}`,
      `https://cdn.example/${key}`,
      `https://cdn.example/sub/${key}`,
      `${key}?v=2`,
      "https://cdn.example/catalog/a%2Ejpg",
    ];
    for (const reference of references) {
      expect(planCatalogPrune({
        objects: [{ key, lastModified: age(30 * DAY) }],
        references: [reference],
        now: NOW,
      })).toEqual([]);
    }
    expect(planCatalogPrune({
      objects: [
        { key: "catalog/fresh.png", lastModified: age(60 * 60 * 1000) },
        { key: "catalog/keep.webp", lastModified: age(30 * DAY) },
        { key: "catalog/orphan.jpg", lastModified: age(30 * DAY) },
      ],
      references: [],
      now: NOW,
    })).toEqual(["catalog/orphan.jpg"]);
  });

  it("age floor boundary is exact in UTC under different TZ", () => {
    const saved = process.env.TZ;
    try {
      for (const tz of ["UTC", "America/Los_Angeles", "Asia/Kolkata"]) {
        process.env.TZ = tz;
        expect(planCatalogPrune({
          objects: [{ key: "catalog/edge.jpg", lastModified: age(CATALOG_PRUNE_MIN_AGE_MS) }],
          references: [],
          now: NOW,
        })).toEqual([]);
        expect(planCatalogPrune({
          objects: [{ key: "catalog/edge.jpg", lastModified: age(CATALOG_PRUNE_MIN_AGE_MS - 1) }],
          references: [],
          now: NOW,
        })).toEqual([]);
        expect(planCatalogPrune({
          objects: [{ key: "catalog/edge.jpg", lastModified: age(CATALOG_PRUNE_MIN_AGE_MS + 1) }],
          references: [],
          now: NOW,
        })).toEqual(["catalog/edge.jpg"]);
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it("planner retains unknown dates and exact boundary and handles encoded references", () => {
    expect(planCatalogPrune({
      objects: [
        { key: "catalog/undated.jpg", lastModified: null },
        { key: "catalog/future.jpg", lastModified: new Date(NOW.getTime() + 60_000) },
        { key: "catalog/dup.jpg", lastModified: age(30 * DAY) },
        { key: "catalog/dup.jpg", lastModified: age(60 * 60 * 1000) },
        { key: "other/old.jpg", lastModified: age(30 * DAY) },
        { key: "catalog/encoded.jpg", lastModified: age(30 * DAY) },
      ],
      references: ["https://cdn.example/catalog/encoded%2Ejpg"],
      now: NOW,
    })).toEqual([]);
    expect(() => planCatalogPrune({
      objects: [{ key: "catalog/orphan.jpg", lastModified: age(30 * DAY) }],
      references: ["catalog/%ZZ"],
      now: NOW,
    })).toThrow(/could not be decoded/);
  });

  it("key matching is case-sensitive; containment over-protects only", () => {
    expect(planCatalogPrune({
      objects: [{ key: "catalog/a.jpg", lastModified: age(30 * DAY) }],
      references: ["catalog/A.jpg"],
      now: NOW,
    })).toEqual(["catalog/a.jpg"]);
    expect(planCatalogPrune({
      objects: [{ key: "catalog/a.jpg", lastModified: age(30 * DAY) }],
      references: ["catalog/a.jpg.bak"],
      now: NOW,
    })).toEqual([]);
  });

  it("batches 2001 candidates as 1000/1000/1 and sends nothing for 0", async () => {
    const keys = Array.from({ length: 2001 }, (_, index) => `catalog/n${index}.jpg`);
    const fake = createFakeR2({
      bucket: BUCKET,
      objects: keys.map((key) => ({ key, lastModified: age(30 * DAY) })),
    });
    const logs: string[] = [];
    await deleteCatalogCandidates({ client: fake, bucket: BUCKET, keys, log: (line) => logs.push(line) });
    const deletes = fake.recorded.filter((command) => command.name === "DeleteObjects");
    expect(deletes.map((command) => command.input.Delete?.Objects?.length)).toEqual([1000, 1000, 1]);
    expect(deletes.every((command) => command.input.Delete?.Quiet === false)).toBe(true);
    expect(logs.filter((line) => line.startsWith("deleted "))).toHaveLength(2001);

    const empty = createFakeR2({ bucket: BUCKET, objects: [] });
    const emptyLogs: string[] = [];
    await deleteCatalogCandidates({ client: empty, bucket: BUCKET, keys: [], log: (line) => emptyLogs.push(line) });
    expect(empty.recorded.filter((command) => command.name === "DeleteObjects")).toEqual([]);
    expect(emptyLogs).toContain("catalog prune: no candidates");
  });

  it("all pages complete before execution and malformed pagination aborts", async () => {
    const objects = Array.from({ length: 2500 }, (_, index) => ({
      key: `catalog/p${index}.jpg`,
      lastModified: age(30 * DAY),
    }));
    const fake = createFakeR2({ bucket: BUCKET, objects });
    const listed = await listCatalogObjects(fake, BUCKET);
    expect(listed).toHaveLength(2500);
    expect(fake.recorded.filter((command) => command.name === "ListObjectsV2")).toHaveLength(3);
    expect(fake.recorded.some((command) => command.name === "DeleteObjects")).toBe(false);

    for (const listFault of ["missing-token", "repeat-token", "throw-on-second-page"] as const) {
      const broken = createFakeR2({ bucket: BUCKET, objects, listFault });
      await expect(listCatalogObjects(broken, BUCKET)).rejects.toThrow(/listing catalog objects failed|pagination is malformed/);
      expect(broken.recorded.some((command) => command.name === "DeleteObjects")).toBe(false);
    }
  });

  it("lost response reports unknown outcomes and stops further batches", async () => {
    const keys = Array.from({ length: 1001 }, (_, index) => `catalog/lost${index}.jpg`);
    const fake = createFakeR2({
      bucket: BUCKET,
      objects: keys.map((key) => ({ key, lastModified: age(30 * DAY) })),
      loseResponseOnBatch: 1,
    });
    const logs: string[] = [];
    await expect(deleteCatalogCandidates({
      client: fake,
      bucket: BUCKET,
      keys,
      log: (line) => logs.push(line),
    })).rejects.toThrow(/outcome unknown/);
    expect(logs.some((line) => line.startsWith("deleted "))).toBe(false);
    expect(logs).toContain("unknown catalog/lost0.jpg");
    expect(logs).toContain("unknown catalog/lost999.jpg");
    expect(logs.some((line) => line.includes("catalog/lost1000.jpg"))).toBe(false);
    expect(fake.recorded.filter((command) => command.name === "DeleteObjects")).toHaveLength(1);
    expect(fake.objects().some((object) => object.key === "catalog/lost0.jpg")).toBe(false);
    expect(fake.objects().some((object) => object.key === "catalog/lost1000.jpg")).toBe(true);
  });

  it("a log failure after a successful delete leaves the provider object deleted", async () => {
    const key = "catalog/logged-late.jpg";
    const fake = createFakeR2({
      bucket: BUCKET,
      objects: [{ key, lastModified: age(30 * DAY) }],
    });
    await expect(deleteCatalogCandidates({
      client: fake,
      bucket: BUCKET,
      keys: [key],
      log: (line) => {
        if (line.startsWith("deleted ")) throw new Error("log interrupted");
      },
    })).rejects.toThrow(/log interrupted/);
    expect(fake.objects().some((object) => object.key === key)).toBe(false);
    const listed = await listCatalogObjects(fake, BUCKET);
    expect(listed.some((object) => object.key === key)).toBe(false);
  });

  it("a mixed unknown and failed delete names both outcomes", async () => {
    const fake = createFakeR2({
      bucket: BUCKET,
      objects: [
        { key: "catalog/denied.jpg", lastModified: age(30 * DAY) },
        { key: "catalog/omitted.jpg", lastModified: age(30 * DAY) },
      ],
      errorKeys: new Set(["catalog/denied.jpg"]),
      omitKeyFromResponse: "catalog/omitted.jpg",
    });
    const logs: string[] = [];
    await expect(deleteCatalogCandidates({
      client: fake,
      bucket: BUCKET,
      keys: ["catalog/denied.jpg", "catalog/omitted.jpg"],
      log: (line) => logs.push(line),
    })).rejects.toThrow(/catalog\/denied.jpg \(AccessDenied\)/);
    expect(logs).toContain("failed catalog/denied.jpg AccessDenied");
    expect(logs).toContain("unknown catalog/omitted.jpg");
    expect(logs.some((line) => line.startsWith("deleted "))).toBe(false);
  });

  it("verbose result must account for every requested key", async () => {
    const fake = createFakeR2({
      bucket: BUCKET,
      objects: [{ key: "catalog/missing-from-response.jpg", lastModified: age(30 * DAY) }],
      omitKeyFromResponse: "catalog/missing-from-response.jpg",
    });
    const logs: string[] = [];
    await expect(deleteCatalogCandidates({
      client: fake,
      bucket: BUCKET,
      keys: ["catalog/missing-from-response.jpg"],
      log: (line) => logs.push(line),
    })).rejects.toThrow(/did not account for every requested key/);
    expect(logs).toContain("unknown catalog/missing-from-response.jpg");
  });

  it("per-key DeleteObjects Errors fail and a throwing second batch reports the first", async () => {
    const errorFake = createFakeR2({
      bucket: BUCKET,
      objects: [
        { key: "catalog/ok.jpg", lastModified: age(30 * DAY) },
        { key: "catalog/denied.jpg", lastModified: age(30 * DAY) },
      ],
      errorKeys: new Set(["catalog/denied.jpg"]),
    });
    const errorLogs: string[] = [];
    await expect(deleteCatalogCandidates({
      client: errorFake,
      bucket: BUCKET,
      keys: ["catalog/ok.jpg", "catalog/denied.jpg"],
      log: (line) => errorLogs.push(line),
    })).rejects.toThrow(/catalog\/denied.jpg \(AccessDenied\)/);
    expect(errorLogs).toContain("deleted catalog/ok.jpg");
    expect(errorLogs).toContain("failed catalog/denied.jpg AccessDenied");

    const keys = Array.from({ length: 2001 }, (_, index) => `catalog/b${index}.jpg`);
    const throwing = createFakeR2({
      bucket: BUCKET,
      objects: keys.map((key) => ({ key, lastModified: age(30 * DAY) })),
      throwOnBatch: 2,
    });
    const logs: string[] = [];
    await expect(deleteCatalogCandidates({
      client: throwing,
      bucket: BUCKET,
      keys,
      log: (line) => logs.push(line),
    })).rejects.toThrow(/outcome unknown/);
    expect(logs.filter((line) => line.startsWith("deleted "))).toHaveLength(1000);
    expect(logs).toContain("unknown catalog/b1000.jpg");
    expect(throwing.recorded.filter((command) => command.name === "DeleteObjects")).toHaveLength(2);
    expect(throwing.objects().some((object) => object.key === "catalog/b1000.jpg")).toBe(true);
    expect(throwing.objects().some((object) => object.key === "catalog/b2000.jpg")).toBe(true);
    expect(throwing.objects().some((object) => object.key === "catalog/b0.jpg")).toBe(false);
  });

  it("fake R2 client rejects empty, oversized, wrong bucket, and unknown commands", async () => {
    const fake = createFakeR2({ bucket: BUCKET, objects: [] });
    const command = (name: string, input: Record<string, unknown>) => ({ constructor: { name }, input });
    await expect(fake.send(command("DeleteObjectsCommand", {
      Bucket: BUCKET,
      Delete: { Objects: [] },
    }))).rejects.toThrow(/MalformedXML/);
    await expect(fake.send(command("DeleteObjectsCommand", {
      Bucket: BUCKET,
      Delete: { Objects: Array.from({ length: 1001 }, (_, index) => ({ Key: `catalog/${index}.jpg` })) },
    }))).rejects.toThrow(/MalformedXML/);
    await expect(fake.send(command("ListObjectsV2Command", { Bucket: "other", Prefix: "catalog/" }))).rejects.toThrow(/NoSuchBucket/);
    await expect(fake.send(command("PutObjectCommand", {}))).rejects.toThrow(/Unknown/);
    const missing = createFakeR2({ bucket: BUCKET, objects: [] });
    const response = await missing.send(command("DeleteObjectsCommand", {
      Bucket: BUCKET,
      Delete: { Objects: [{ Key: "catalog/missing.jpg" }], Quiet: false },
    })) as { Deleted?: { Key?: string }[] };
    expect(response.Deleted?.map((entry) => entry.Key)).toEqual(["catalog/missing.jpg"]);
  });

  it("real SDK serializes the supported delete request and parses mixed results", async () => {
    let body = "";
    let capturedHeaders: string[] = [];
    const client = new S3Client({
      region: "auto",
      endpoint: "https://example.r2.cloudflarestorage.com",
      credentials: { accessKeyId: "AKIA_TEST", secretAccessKey: "test-secret" },
      requestHandler: {
        handle: async (request: { body?: Uint8Array | string; headers?: Record<string, string> }) => {
          const raw = request.body;
          body = typeof raw === "string" ? raw : Buffer.from(raw ?? new Uint8Array()).toString("utf8");
          const headerNames = Object.keys(request.headers ?? {}).map((name) => name.toLowerCase());
          capturedHeaders = headerNames;
          const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Deleted><Key>catalog/a.jpg</Key></Deleted>
  <Error><Key>catalog/b.jpg</Key><Code>AccessDenied</Code><Message>Access Denied</Message></Error>
</DeleteResult>`;
          return {
            response: {
              statusCode: 200,
              headers: { "content-type": "application/xml" },
              body: new TextEncoder().encode(xml),
            },
          };
        },
      },
    });
    const result = await client.send(new DeleteObjectsCommand({
      Bucket: BUCKET,
      Delete: {
        Objects: [{ Key: "catalog/a.jpg" }, { Key: "catalog/b.jpg" }],
        Quiet: false,
      },
    }));
    expect(body).toContain("catalog/a.jpg");
    expect(body).toContain("catalog/b.jpg");
    expect(body).not.toContain("<Quiet>true</Quiet>");
    expect(result.Deleted?.map((entry) => entry.Key)).toEqual(["catalog/a.jpg"]);
    expect(result.Errors?.map((entry) => entry.Code)).toEqual(["AccessDenied"]);
    expect(capturedHeaders.some((name) => name === "content-md5" || name.startsWith("x-amz-checksum-"))).toBe(true);
  });

  it("the reference reader is not imported by an app route or server action", () => {
    const roots = [path.join(process.cwd(), "src", "app")];
    const hits: string[] = [];
    const visit = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) visit(full);
        else if (/\.(ts|tsx)$/.test(entry)) {
          const text = readFileSync(full, "utf8");
          if (text.includes("catalog-prune-reader") || text.includes("readCatalogImageReferences")) hits.push(full);
        }
      }
    };
    for (const root of roots) visit(root);
    expect(hits).toEqual([]);
    const seed = readFileSync(path.join(process.cwd(), "prisma", "seed.ts"), "utf8");
    expect(seed).not.toContain('kind: "harness"');
    const tree = ["src", "prisma", "scripts"];
    const deleteHits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (entry === "node_modules" || entry === ".next") continue;
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx|mjs|js)$/.test(entry)) {
          const text = readFileSync(full, "utf8");
          if (text.includes("DeleteObjectsCommand") || text.includes("new DeleteObject")) deleteHits.push(path.relative(process.cwd(), full));
        }
      }
    };
    for (const root of tree) walk(path.join(process.cwd(), root));
    expect(deleteHits.filter((file) => !file.endsWith(".test.ts"))).toEqual([
      path.normalize("src/lib/catalog-prune-execute.ts"),
      path.normalize("src/lib/r2.ts"),
    ]);
    const r2Source = readFileSync(path.join(process.cwd(), "src", "lib", "r2.ts"), "utf8");
    expect(r2Source.match(/new DeleteObject/g)).toHaveLength(1);
  });

  it("the r2.ts delete only ever targets the proof bucket with a proof key", async () => {
    vi.stubEnv("R2_ACCOUNT_ID", "acct-sentinel");
    vi.stubEnv("R2_ACCESS_KEY_ID", ACCESS);
    vi.stubEnv("R2_SECRET_ACCESS_KEY", SECRET);
    vi.stubEnv("R2_BUCKET", BUCKET);
    vi.stubEnv("R2_PROOF_BUCKET", "proof-bucket");
    const send = vi.spyOn(S3Client.prototype, "send").mockResolvedValue({} as never);
    try {
      await deleteDeliveryProof("delivery-proof/ord1/1700000000000-0123456789abcdef.jpg");
      expect(send).toHaveBeenCalledTimes(1);
      const sent = send.mock.calls[0][0] as { constructor: { name: string }; input: { Bucket: string; Key: string } };
      expect(sent.constructor.name).toBe("DeleteObjectCommand");
      expect(sent.input).toEqual({ Bucket: "proof-bucket", Key: "delivery-proof/ord1/1700000000000-0123456789abcdef.jpg" });
      for (const key of ["catalog/a.jpg", "issue-photo/ord1/iss1.jpg", "delivery-proof/../catalog/a.jpg"]) {
        await expect(deleteDeliveryProof(key)).rejects.toThrow("not a delivery-proof key");
      }
      vi.stubEnv("R2_PROOF_BUCKET", "");
      await expect(deleteDeliveryProof("delivery-proof/ord1/1700000000000.jpg")).rejects.toThrow("R2_PROOF_BUCKET is required");
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      send.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

describe("lane env filter script", () => {
  const inherited = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "SEED_PRUNE_R2", "DATABASE_URL_UNPOOLED"] as const;
  const saved = new Map<string, string | undefined>();
  beforeAll(() => {
    for (const key of inherited) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });
  afterAll(() => {
    for (const key of inherited) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const ticketEnv = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "t225-env-"));
    const file = path.join(dir, "ticket-env.txt");
    writeFileSync(file, [
      "22 DATABASE_URL",
      "225 DATABASE_URL DIRECT_URL APP_RUNTIME_PASSWORD",
      "75 DATABASE_URL",
      "7 DATABASE_URL",
      "93 DATABASE_URL R2_SECRET_ACCESS_KEY R2_BUCKET  # optional: R2_PUBLIC_URL",
      "100 DATABASE_URL # R2_SECRET_ACCESS_KEY",
      "",
    ].join("\n"));
    return { dir, file };
  };

  it("ticket listing R2_SECRET_ACCESS_KEY keeps R2 keys", () => {
    const env = ticketEnv();
    const src = path.join(env.dir, "src");
    const dest = path.join(env.dir, "dest");
    const input = `R2_SECRET_ACCESS_KEY=${SECRET}\nR2_ACCESS_KEY_ID=${ACCESS}\nSEED_PRUNE_R2=${BUCKET}\nKEEP=1\n`;
    writeFileSync(src, input);
    const stdout = execFileSync(process.execPath, ["scripts/lane-env.mjs", "filter", "93", src, dest, env.file], { encoding: "utf8" });
    const output = readFileSync(dest, "utf8");
    expect(output).toContain(`R2_SECRET_ACCESS_KEY=${SECRET}`);
    expect(output).toContain(`R2_ACCESS_KEY_ID=${ACCESS}`);
    expect(output).not.toContain("SEED_PRUNE_R2");
    expect(stdout).toContain("withheld SEED_PRUNE_R2");
    expect(stdout).not.toContain("withheld R2_SECRET_ACCESS_KEY");
    rmSync(env.dir, { recursive: true, force: true });
  });

  it("ticket 22 does not match line 225; 7 does not match 75", () => {
    const env = ticketEnv();
    const keys22 = execFileSync(process.execPath, ["scripts/lane-env.mjs", "keys", "22", env.file], { encoding: "utf8" });
    const keys7 = execFileSync(process.execPath, ["scripts/lane-env.mjs", "keys", "7", env.file], { encoding: "utf8" });
    const keys225 = execFileSync(process.execPath, ["scripts/lane-env.mjs", "keys", "225", env.file], { encoding: "utf8" });
    expect(keys22.trim()).toBe("DATABASE_URL");
    expect(keys7.trim()).toBe("DATABASE_URL");
    expect(keys225).not.toContain("R2_");
    const real = readFileSync(path.join(process.cwd(), "scripts", "ticket-env.txt"), "utf8");
    const line = real.split(/\r?\n/).find((entry) => entry.startsWith("225 "));
    expect(line).toBe("225 DATABASE_URL DIRECT_URL APP_RUNTIME_PASSWORD");
    rmSync(env.dir, { recursive: true, force: true });
  });

  it("usage errors name the accepted command instead of a generic filter failure", () => {
    const cases = [
      { args: [] as string[], stderr: "usage: lane-env.mjs filter|child-env|keys|strip ..." },
      { args: ["nope"], stderr: "usage: lane-env.mjs filter|child-env|keys|strip ..." },
      { args: ["filter"], stderr: "usage: filter <ticket> <src> <dest> <ticket-env>" },
      { args: ["keys"], stderr: "usage: keys <ticket> <ticket-env>" },
      { args: ["child-env"], stderr: "usage: child-env <ticket> <ticket-env>" },
      { args: ["filter", "225", "only-one"], stderr: "usage: filter <ticket> <src> <dest> <ticket-env>" },
    ];
    for (const entry of cases) {
      const result = spawnSync(process.execPath, ["scripts/lane-env.mjs", ...entry.args], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toBe(entry.stderr);
    }
  });

  it("an unreadable filter source removes a stale destination", () => {
    const env = ticketEnv();
    const src = path.join(env.dir, "srcdir");
    const dest = path.join(env.dir, "dest");
    mkdirSync(src);
    writeFileSync(dest, `R2_SECRET_ACCESS_KEY=${SECRET}\n`);
    const result = spawnSync(process.execPath, ["scripts/lane-env.mjs", "filter", "225", src, dest, env.file], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(existsSync(dest)).toBe(false);
    expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
    rmSync(env.dir, { recursive: true, force: true });
  });

  it("build-ticket.sh filters the lane env before any mode, so --resume and --continue children get no secret keys", async (ctx) => {
    const started = Date.now();
    const text = readFileSync(path.join(process.cwd(), "scripts", "build-ticket.sh"), "utf8");
    expect(text).not.toContain("cp .env.local");
    const prepareAt = text.indexOf("prepare_lane_env");
    expect(prepareAt).toBeGreaterThan(-1);
    expect(prepareAt).toBeLessThan(text.indexOf('case "$MODE"'));
    const env = ticketEnv();
    try {
      const src = path.join(env.dir, "src");
      const dest = path.join(env.dir, "dest");
      writeFileSync(src, [
        "KEEP=1",
        `R2_SECRET_ACCESS_KEY = ${SECRET}`,
        `export R2_ACCESS_KEY_ID: ${ACCESS}`,
        "SEED_PRUNE_R2:",
        "dry-run",
        `DATABASE_URL_UNPOOLED="postgresql://user:${SECRET}@remote.example/db"`,
        "",
      ].join("\r\n"));
      const bashPath = (file: string) => file.replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);
      const script = `
        set -euo pipefail
        export R2_SECRET_ACCESS_KEY='${SECRET}'
        export R2_ACCESS_KEY_ID='${ACCESS}'
        export SEED_PRUNE_R2='${BUCKET}'
        export DATABASE_URL_UNPOOLED='postgresql://user:${SECRET}@remote.example/db'
        source scripts/lane-env.sh
        prepare_lane_env 225 "${bashPath(src)}" "${bashPath(dest)}" "${bashPath(env.file)}"
        node -e 'const keys=["R2_SECRET_ACCESS_KEY","R2_ACCESS_KEY_ID","SEED_PRUNE_R2","DATABASE_URL_UNPOOLED"]; const present=keys.filter((key)=>process.env[key]); if (present.length) { console.log("present:"+present.join(",")); process.exit(1);} console.log("absent");'
      `;
      const { stdout } = await runCommand(gitBash(), ["-c", script], {
        cwd: process.cwd(),
        timeoutMs: commandBudget(started, 15_000),
        signal: ctx.signal,
      });
      expect(stdout).toContain("absent");
      expect(stdout).not.toContain(SECRET);
      expect(readFileSync(dest, "utf8")).toBe("KEEP=1\r\n");
    } finally {
      removeTemp(env.dir);
    }
  });


  it("lane-db strips unpooled and prune assignments, spaced and CRLF-continued, and unsets them for children", () => {
    const text = readFileSync(path.join(process.cwd(), "scripts", "lane-db.sh"), "utf8");
    expect(text).toContain('lane-env.mjs" strip "$ENV_FILE" DATABASE_URL DIRECT_URL APP_RUNTIME_PASSWORD DATABASE_URL_UNPOOLED SEED_PRUNE_R2');
    expect(text).toContain("unset DATABASE_URL_UNPOOLED SEED_PRUNE_R2");
    const dir = mkdtempSync(path.join(tmpdir(), "t225-lanedb-"));
    try {
      const envFile = path.join(dir, "env");
      writeFileSync(envFile, [
        "KEEP=1",
        `DATABASE_URL_UNPOOLED = postgresql://user:${SECRET}@remote.example/db`,
        `DATABASE_URL_UNPOOLED: postgresql://user:${SECRET}@other.example/db`,
        "SEED_PRUNE_R2: dry-run",
        `DATABASE_URL=postgresql://user:${SECRET}@remote.example/neondb`,
        "",
      ].join("\n") + [
        "DATABASE_URL_UNPOOLED:",
        `postgresql://user:${SECRET}@crlf.example/db`,
        "SEED_PRUNE_R2:",
        "dry-run",
        "",
      ].join("\r\n"));
      const result = spawnSync(process.execPath, [
        "scripts/lane-env.mjs", "strip", envFile,
        "DATABASE_URL", "DIRECT_URL", "APP_RUNTIME_PASSWORD", "DATABASE_URL_UNPOOLED", "SEED_PRUNE_R2",
      ], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
      const written = readFileSync(envFile, "utf8");
      for (const gone of ["DATABASE_URL", "SEED_PRUNE_R2", "remote.example", "other.example", "crlf.example", "dry-run", SECRET]) {
        expect(written).not.toContain(gone);
      }
      expect(written).toContain("KEEP=1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("formatR2UploadCause", () => {
  it("keeps a cause with a newline or carriage return in its name, code or message on one line", async () => {
    const { formatR2UploadCause } = await import("../../prisma/seed-master-catalog");
    const cause = Object.assign(new Error("Access\rDenied\r\nsecond line"), {
      name: "Access\nDenied",
      code: "Bad\r\nCode",
      $metadata: { httpStatusCode: 403 },
    });
    const line = formatR2UploadCause(cause);
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toBe("Access (HTTP 403): Access (Bad)");
  });
});
