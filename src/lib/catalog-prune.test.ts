import { DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
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
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

/**
 * On Windows a bash script stub takes about 1.5s to start, and a node shebang is
 * dispatched by bash, so either one pushes lane-db.sh past 15s while other lanes
 * are running. scripts/catalog-prune-stub.exe is a native binary (about 30ms) that
 * behaves as psql, npx, git, gh, claude, pg_ctl or pg_isready based on its name.
 * installWinUtils adds dirname, mktemp, cat, mv, grep, date, ls, mkdir, tail, tr, sed,
 * cut and rm. Lane-db starts four of those; the harness starts them on every mode.
 * Linux keeps the real binaries: process start is cheap there, and the exe is Windows.
 */
const NATIVE_STUB = path.join(process.cwd(), "scripts", "catalog-prune-stub.exe");

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

/** Milliseconds left before the Vitest timeout, so this helper fires first. Budgets stay 15s and 180s. */
function commandBudget(startedAt: number, testMs: number): number {
  return Math.max(1_000, testMs - (Date.now() - startedAt) - 750);
}
const nodeExit = "#!/usr/bin/env node\nprocess.exit(0);\n";

/**
 * Stub directory, then Git bash and node. A full Windows PATH makes MSYS search every
 * entry before it finds bash or node, and that alone pushed lane-db.sh past 15s.
 */
function commandPath(bin: string): string {
  const toBash = (file: string) => file.replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);
  if (process.platform !== "win32") return `${toBash(bin)}:${process.env.PATH ?? ""}`;
  const bashDir = toBash(path.dirname(gitBash()));
  const nodeDir = toBash(path.dirname(process.execPath));
  return `${toBash(bin)}:${bashDir}:${nodeDir}:/usr/bin`;
}

const WIN_UTILS = ["dirname", "mktemp", "cat", "mv", "grep", "date", "ls", "mkdir", "tail", "tr", "sed", "cut", "rm"] as const;

/** Windows only. A native exe is one CreateProcess with no MSYS DLL startup. */
function installWinUtils(bin: string): void {
  if (process.platform !== "win32") return;
  for (const name of WIN_UTILS) installStub(bin, name, "");
}

function installStub(bin: string, name: string, nodeBody: string): void {
  if (process.platform === "win32") {
    const dest = path.join(bin, `${name}.exe`);
    // A hard link is the already-scanned stub, so Windows does not rescan each name.
    try { linkSync(NATIVE_STUB, dest); } catch { copyFileSync(NATIVE_STUB, dest); }
    return;
  }
  const file = path.join(bin, name);
  writeFileSync(file, nodeBody);
  chmodSync(file, 0o755);
}

// Do not read stdin. A stub that waits for EOF sits on Windows until the pipe
// closes, and that pushed lane-db.sh past 15s. The heredoc is smaller than the
// pipe buffer, and exiting still lets local-pg.sh finish.
const nodePsql = `#!/usr/bin/env node
const fs = require("fs");
if (process.env.HARNESS_LOG) fs.appendFileSync(process.env.HARNESS_LOG, "psql\\n");
process.exit(0);
`;

function nodeNpxLine(): string {
  return `#!/usr/bin/env node
const fs = require("fs");
const url = process.env.DATABASE_URL || "";
let host = "missing";
try { if (url) host = new URL(url).hostname || "missing"; } catch { host = "missing"; }
const flag = (name) => (process.env[name] ? "present" : "");
fs.appendFileSync(process.env.HARNESS_LOG, "child npx host=" + host + " secret=" + flag("R2_SECRET_ACCESS_KEY") + " unpooled=" + flag("DATABASE_URL_UNPOOLED") + " prune=" + flag("SEED_PRUNE_R2") + "\\n");
process.exit(0);
`;
}

function nodeChild(label: string): string {
  return `#!/usr/bin/env node
const fs = require("fs");
const url = process.env.DATABASE_URL || "";
let host = "missing";
try { if (url) host = new URL(url).hostname || "missing"; } catch { host = "missing"; }
const flag = (name) => (process.env[name] ? "present" : "");
fs.appendFileSync(process.env.HARNESS_LOG, "child ${label} host=" + host + " secret=" + flag("R2_SECRET_ACCESS_KEY") + " access=" + flag("R2_ACCESS_KEY_ID") + " unpooled=" + flag("DATABASE_URL_UNPOOLED") + " prune=" + flag("SEED_PRUNE_R2") + "\\n");
`;
}

/** review-ticket and ci-local are invoked with bash, which ignores a node shebang. */
function bashChild(label: string, trailer: string): string {
  return `#!/bin/bash
url="\${DATABASE_URL:-}"
host=missing
if [ -n "$url" ]; then
  rest="\${url#*@}"
  if [ "$rest" = "$url" ]; then rest="\${url#*://}"; fi
  host="\${rest%%[:/]*}"
  [ -n "$host" ] || host=missing
fi
secret=\${R2_SECRET_ACCESS_KEY:+present}
access=\${R2_ACCESS_KEY_ID:+present}
unpooled=\${DATABASE_URL_UNPOOLED:+present}
prune=\${SEED_PRUNE_R2:+present}
printf 'child ${label} host=%s secret=%s access=%s unpooled=%s prune=%s\\n' "$host" "$secret" "$access" "$unpooled" "$prune" >> "$HARNESS_LOG"
${trailer}
`;
}

/**
 * The harness used to run seven greps per mode. Each grep is an MSYS process.
 * [[ ]] is a builtin. A quoted pattern is literal, so the sentinel cannot hide in a regex.
 * Failure text goes to stderr, which runCommand includes in the rejection.
 */
function harnessLogCheck(): string {
  return `
    log=$(<"$HARNESS_LOG")
    need() { [[ $log == *"$1"* ]] || { echo "missing:$1" >&2; exit 1; }; }
    need "child npx host=localhost"
    need "child claude"
    need "child review"
    need "psql"
    need "git fetch"
    if [[ $log == *"secret=present"* || $log == *"access=present"* || $log == *"unpooled=present"* || $log == *"prune=present"* ]]; then
      echo "leaked child env" >&2
      exit 1
    fi
    if [[ $log == *"${SECRET}"* ]]; then echo "secret in log" >&2; exit 1; fi
  `;
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
    ]);
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

  it("ticket without an R2 line drops R2 write keys and SEED_PRUNE_R2, keeps every other line byte-for-byte", () => {
    const env = ticketEnv();
    const src = path.join(env.dir, "src");
    const dest = path.join(env.dir, "dest");
    const input = [
      "KEEP=plain",
      `R2_ACCESS_KEY_ID=${ACCESS}`,
      `R2_SECRET_ACCESS_KEY=${SECRET}`,
      "SEED_PRUNE_R2=dry-run",
      "R2_BUCKET=unit-bucket",
      "# comment",
      "",
    ].join("\n");
    writeFileSync(src, input);
    const stdout = execFileSync(process.execPath, ["scripts/lane-env.mjs", "filter", "225", src, dest, env.file], { encoding: "utf8" });
    expect(readFileSync(dest, "utf8")).toBe(["KEEP=plain", "R2_BUCKET=unit-bucket", "# comment", ""].join("\n"));
    expect(stdout).toContain("withheld R2_ACCESS_KEY_ID");
    expect(stdout).toContain("withheld R2_SECRET_ACCESS_KEY");
    expect(stdout).toContain("withheld SEED_PRUNE_R2");
    expect(stdout).not.toContain(SECRET);
    expect(stdout).not.toContain(ACCESS);
    rmSync(env.dir, { recursive: true, force: true });
  });

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

  it("R2-authorized tickets retain credentials but never prune opt-in", () => {
    const env = ticketEnv();
    const src = path.join(env.dir, "src");
    const dest = path.join(env.dir, "dest");
    writeFileSync(src, `SEED_PRUNE_R2=dry-run\nR2_SECRET_ACCESS_KEY=${SECRET}\n`);
    execFileSync(process.execPath, ["scripts/lane-env.mjs", "filter", "93", src, dest, env.file]);
    const child = execFileSync(process.execPath, ["scripts/lane-env.mjs", "child-env", "93", env.file], { encoding: "utf8" });
    expect(readFileSync(dest, "utf8")).toBe(`R2_SECRET_ACCESS_KEY=${SECRET}\n`);
    expect(child).toContain("unset SEED_PRUNE_R2");
    expect(child).not.toContain("unset R2_SECRET_ACCESS_KEY");
    rmSync(env.dir, { recursive: true, force: true });
  });

  it("parses CRLF, export prefix, quotes and trailing comments", () => {
    const env = ticketEnv();
    const src = path.join(env.dir, "src");
    const dest = path.join(env.dir, "dest");
    const input = `\uFEFFexport KEEP="a=b"\r\nR2_SECRET_ACCESS_KEY="${SECRET}"\r\n# comment\r\n\r\n`;
    writeFileSync(src, input);
    execFileSync(process.execPath, ["scripts/lane-env.mjs", "filter", "225", src, dest, env.file]);
    expect(readFileSync(dest, "utf8")).toBe(`\uFEFFexport KEEP="a=b"\r\n# comment\r\n\r\n`);
    rmSync(env.dir, { recursive: true, force: true });
  });

  it("comment tokens cannot grant R2 permissions and duplicate assignments cannot leak keys", () => {
    const env = ticketEnv();
    const src = path.join(env.dir, "src");
    const dest = path.join(env.dir, "dest");
    writeFileSync(src, `R2_SECRET_ACCESS_KEY=${SECRET}\nKEEP=yes\nR2_ACCESS_KEY_ID=${ACCESS}\nR2_SECRET_ACCESS_KEY = ${SECRET}\n`);
    const stdout = execFileSync(process.execPath, ["scripts/lane-env.mjs", "filter", "100", src, dest, env.file], { encoding: "utf8" });
    expect(readFileSync(dest, "utf8")).toBe("KEEP=yes\n");
    expect(stdout).not.toContain(SECRET);
    const keys = execFileSync(process.execPath, ["scripts/lane-env.mjs", "keys", "100", env.file], { encoding: "utf8" });
    expect(keys.trim().split(/\s+/)).toEqual(["DATABASE_URL"]);
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

  it("prints withheld key names, never values", () => {
    const env = ticketEnv();
    const src = path.join(env.dir, "src");
    const dest = path.join(env.dir, "dest");
    writeFileSync(src, `SEED_PRUNE_R2=${SECRET}\n`);
    const stdout = execFileSync(process.execPath, ["scripts/lane-env.mjs", "filter", "225", src, dest, env.file], { encoding: "utf8" });
    expect(stdout).toContain("withheld SEED_PRUNE_R2");
    expect(stdout).not.toContain(SECRET);
    rmSync(env.dir, { recursive: true, force: true });
  });

  it("build-ticket.sh writes the lane .env.local only through the filter", () => {
    const text = readFileSync(path.join(process.cwd(), "scripts", "build-ticket.sh"), "utf8");
    expect(text).not.toContain("cp .env.local");
    const prepareAt = text.indexOf("prepare_lane_env");
    const caseAt = text.indexOf('case "$MODE"');
    const laneDbAt = text.indexOf("lane-db.sh");
    expect(prepareAt).toBeGreaterThan(-1);
    expect(prepareAt).toBeLessThan(caseAt);
    expect(laneDbAt).toBeGreaterThan(prepareAt);
  });

  it("build resume and continue sanitize inherited env before first child", async (ctx) => {
    const env = ticketEnv();
    try {
      const src = path.join(env.dir, "src");
      const dest = path.join(env.dir, "dest");
      writeFileSync(src, `KEEP=1\nDATABASE_URL_UNPOOLED=postgresql://user:${SECRET}@ep-test.neon.tech/neondb\n`);
      const bashPath = (file: string) => file.replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);
      const script = `
        set -euo pipefail
        cd "${bashPath(process.cwd())}"
        export R2_SECRET_ACCESS_KEY='${SECRET}'
        export R2_ACCESS_KEY_ID='${ACCESS}'
        export SEED_PRUNE_R2='${BUCKET}'
        export DATABASE_URL_UNPOOLED='postgresql://user:${SECRET}@ep-test.neon.tech/neondb'
        export DIRECT_URL='postgresql://app_owner:app_owner@localhost:5434/lane_t225'
        export DATABASE_URL="$DIRECT_URL"
        source scripts/lane-env.sh
        prepare_lane_env 225 "${bashPath(src)}" "${bashPath(dest)}" "${bashPath(env.file)}"
        node -e 'const keys=["R2_SECRET_ACCESS_KEY","R2_ACCESS_KEY_ID","SEED_PRUNE_R2","DATABASE_URL_UNPOOLED"]; const present=keys.filter((key)=>process.env[key]); if (present.length) { console.log("present:"+present.join(",")); process.exit(1);} console.log("absent");'
        npx tsx -e "import { resolveDirectUrl } from './src/lib/env.ts'; const host = new URL(resolveDirectUrl()).hostname; if (host !== 'localhost') { console.log('host:'+host); process.exit(1);} console.log('host:localhost');"
      `;
      const { stdout } = await runCommand("bash", ["-c", script], { timeoutMs: 59_000, signal: ctx.signal });
      expect(stdout).toContain("absent");
      expect(stdout).toContain("host:localhost");
      expect(stdout).not.toContain(SECRET);
      expect(readFileSync(dest, "utf8")).not.toContain("DATABASE_URL_UNPOOLED");
    } finally {
      removeTemp(env.dir);
    }
  }, 60_000);

  it("lane direct-url resolution cannot select copied or inherited remote unpooled URL", () => {
    const text = readFileSync(path.join(process.cwd(), "scripts", "lane-db.sh"), "utf8");
    expect(text).toContain("DATABASE_URL_UNPOOLED");
    expect(text).toContain("unset DATABASE_URL_UNPOOLED SEED_PRUNE_R2");
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

  it("spaced assignments cannot leak write keys or a remote unpooled URL", () => {
    const env = ticketEnv();
    const src = path.join(env.dir, "src");
    const dest = path.join(env.dir, "dest");
    writeFileSync(src, [
      "KEEP=plain",
      `R2_ACCESS_KEY_ID = ${ACCESS}`,
      `R2_SECRET_ACCESS_KEY = ${SECRET}`,
      "SEED_PRUNE_R2 = dry-run",
      `DATABASE_URL_UNPOOLED = postgresql://user:${SECRET}@remote.example/db`,
      "OTHER=1",
      "",
    ].join("\n"));
    execFileSync(process.execPath, ["scripts/lane-env.mjs", "filter", "225", src, dest, env.file]);
    expect(readFileSync(dest, "utf8")).toBe("KEEP=plain\nOTHER=1\n");
    const probe = execFileSync(process.execPath, [
      `--env-file=${dest}`,
      "-e",
      "const names=['R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','SEED_PRUNE_R2','DATABASE_URL_UNPOOLED']; const present=names.filter((name)=>process.env[name]); if (present.length) { console.log('PRESENT '+present.join(',')); process.exit(1);} console.log('ABSENT');",
    ], { encoding: "utf8" });
    expect(probe).toContain("ABSENT");
    expect(probe).not.toContain(SECRET);
    rmSync(env.dir, { recursive: true, force: true });
  });

  it("dotenv colon assignments cannot leak write keys or a remote unpooled URL", async (ctx) => {
    const env = ticketEnv();
    try {
      const src = path.join(env.dir, "src");
      const dest = path.join(env.dir, "dest");
      writeFileSync(src, [
        "KEEP: plain",
        `export R2_ACCESS_KEY_ID: ${ACCESS}`,
        `R2_SECRET_ACCESS_KEY: ${SECRET}`,
        "SEED_PRUNE_R2: dry-run",
        `DATABASE_URL_UNPOOLED: postgresql://user:${SECRET}@remote.example/db`,
        "DIRECT_URL=postgresql://app_owner:app_owner@localhost:5434/lane_t225",
        "",
      ].join("\n"));
      execFileSync(process.execPath, ["scripts/lane-env.mjs", "filter", "225", src, dest, env.file]);
      const written = readFileSync(dest, "utf8");
      expect(written).toContain("KEEP: plain");
      expect(written).toContain("DIRECT_URL=postgresql://app_owner:app_owner@localhost:5434/lane_t225");
      expect(written).not.toContain(SECRET);
      expect(written).not.toContain("SEED_PRUNE_R2");
      expect(written).not.toContain("remote.example");
      const bashDest = dest.replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);
      const { stdout: probe } = await runCommand("bash", ["-c", `pnpm exec dotenv -e "${bashDest}" -- node -e 'const names=["R2_ACCESS_KEY_ID","R2_SECRET_ACCESS_KEY","SEED_PRUNE_R2","DATABASE_URL_UNPOOLED"]; const present=names.filter((name)=>process.env[name]); const chosen=process.env.DATABASE_URL_UNPOOLED||process.env.DIRECT_URL||""; let host="missing"; try{host=new URL(chosen).hostname}catch(e){} if(present.length){console.log("PRESENT"); process.exit(1)} console.log("host:"+host);'`], {
        cwd: process.cwd(),
        timeoutMs: 14_500,
        signal: ctx.signal,
      });
      expect(probe).toContain("host:localhost");
      expect(probe).not.toContain("PRESENT");
      expect(probe).not.toContain(SECRET);
    } finally {
      removeTemp(env.dir);
    }
  });

  it("a dotenv value on the line after a colon cannot leak", async (ctx) => {
    const started = Date.now();
    const env = ticketEnv();
    try {
      const src = path.join(env.dir, "src");
      const dest = path.join(env.dir, "dest");
      writeFileSync(src, [
        "KEEP=plain",
        "R2_SECRET_ACCESS_KEY:",
        SECRET,
        "R2_ACCESS_KEY_ID:",
        ACCESS,
        "SEED_PRUNE_R2:",
        "dry-run",
        "DATABASE_URL_UNPOOLED:",
        `postgresql://user:${SECRET}@remote.example/db`,
        "DIRECT_URL=postgresql://app_owner:app_owner@localhost:5434/lane_t225",
        "",
      ].join("\n"));
      execFileSync(process.execPath, ["scripts/lane-env.mjs", "filter", "225", src, dest, env.file]);
      const written = readFileSync(dest, "utf8");
      expect(written).toContain("KEEP=plain");
      expect(written).toContain("localhost");
      expect(written).not.toContain(SECRET);
      expect(written).not.toContain("dry-run");
      expect(written).not.toContain("remote.example");
      const bashDest = dest.replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);
      const loadProbe = `pnpm exec dotenv -e "${bashDest}" -- node -e 'const names=["R2_ACCESS_KEY_ID","R2_SECRET_ACCESS_KEY","SEED_PRUNE_R2","DATABASE_URL_UNPOOLED"]; const present=names.filter((name)=>process.env[name]); const chosen=process.env.DATABASE_URL_UNPOOLED||process.env.DIRECT_URL||""; let host="missing"; try{host=new URL(chosen).hostname}catch(e){} if(present.length){console.log("PRESENT"); process.exit(1)} console.log("host:"+host);'`;
      const probe = await runCommand("bash", ["-c", loadProbe], { cwd: process.cwd(), timeoutMs: commandBudget(started, 15_000), signal: ctx.signal });
      expect(probe.stdout).toContain("host:localhost");
      expect(probe.stdout).not.toContain("PRESENT");
      expect(probe.stdout).not.toContain(SECRET);
      writeFileSync(src, [
        "KEEP=plain",
        "R2_SECRET_ACCESS_KEY:",
        SECRET,
        "R2_ACCESS_KEY_ID:",
        ACCESS,
        "SEED_PRUNE_R2:",
        "dry-run",
        "DATABASE_URL_UNPOOLED:",
        `postgresql://user:${SECRET}@remote.example/db`,
        "DIRECT_URL=postgresql://app_owner:app_owner@localhost:5434/lane_t225",
        "",
      ].join("\r\n"));
      execFileSync(process.execPath, ["scripts/lane-env.mjs", "filter", "225", src, dest, env.file]);
      const crlf = readFileSync(dest, "utf8");
      expect(crlf).toContain("KEEP=plain");
      expect(crlf).toContain("localhost");
      expect(crlf).not.toContain(SECRET);
      expect(crlf).not.toContain("dry-run");
      expect(crlf).not.toContain("remote.example");
      expect(crlf).not.toContain("R2_SECRET_ACCESS_KEY");
      expect(crlf).not.toContain("R2_ACCESS_KEY_ID");
      const crlfProbe = await runCommand("bash", ["-c", loadProbe], { cwd: process.cwd(), timeoutMs: commandBudget(started, 15_000), signal: ctx.signal });
      expect(crlfProbe.stdout).toContain("host:localhost");
      expect(crlfProbe.stdout).not.toContain("PRESENT");
      expect(crlfProbe.stdout).not.toContain(SECRET);
    } finally {
      removeTemp(env.dir);
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

  it("filter failure stops before seeding and cannot reuse stale unsafe env", () => {
    const env = ticketEnv();
    const dest = path.join(env.dir, "dest");
    writeFileSync(dest, `R2_SECRET_ACCESS_KEY=${SECRET}\n`);
    const result = spawnSync(process.execPath, ["scripts/lane-env.mjs", "filter", "225", path.join(env.dir, "missing"), dest, env.file], {
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(existsSync(dest)).toBe(false);
    expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
    rmSync(env.dir, { recursive: true, force: true });
  });

  it("lane-db drops spaced unpooled assignments and points children at localhost", async (ctx) => {
    const started = Date.now();
    const dir = mkdtempSync(path.join(tmpdir(), "t225-lanedb-"));
    try {
    const bin = path.join(dir, "bin");
    const data = path.join(dir, "pg");
    mkdirSync(bin);
    mkdirSync(data);
    writeFileSync(path.join(data, "PG_VERSION"), "18\n");
    const log = path.join(dir, "log");
    writeFileSync(log, "");
    const bashPath = (file: string) => file.replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);
    installStub(bin, "psql", nodePsql);
    installStub(bin, "pg_ctl", nodeExit);
    installStub(bin, "pg_isready", nodeExit);
    installStub(bin, "npx", nodeNpxLine());
    installWinUtils(bin);
    const envFile = path.join(dir, "env");
    writeFileSync(envFile, [
      "KEEP=1",
      `DATABASE_URL_UNPOOLED = postgresql://user:${SECRET}@remote.example/db`,
      `DATABASE_URL_UNPOOLED: postgresql://user:${SECRET}@other.example/db`,
      "SEED_PRUNE_R2: dry-run",
      `DATABASE_URL=postgresql://user:${SECRET}@remote.example/neondb`,
      `R2_SECRET_ACCESS_KEY = ${SECRET}`,
      "",
    ].join("\n") + [
      "DATABASE_URL_UNPOOLED:",
      `postgresql://user:${SECRET}@crlf.example/db`,
      "SEED_PRUNE_R2:",
      "dry-run",
      "",
    ].join("\r\n"));
    await runCommand(gitBash(), ["scripts/lane-db.sh", "zzorch", bashPath(envFile)], {
      env: {
        ...process.env,
        DATABASE_URL_UNPOOLED: `postgresql://user:${SECRET}@remote.example/db`,
        SEED_PRUNE_R2: "dry-run",
        PGBIN: bashPath(bin),
        LANE_PG_DATA: bashPath(data),
        HARNESS_LOG: bashPath(log),
        PATH: commandPath(bin),
      },
      timeoutMs: commandBudget(started, 15_000),
      signal: ctx.signal,
    });
    const written = readFileSync(envFile, "utf8");
    expect(written).not.toContain("DATABASE_URL_UNPOOLED");
    expect(written).not.toContain("SEED_PRUNE_R2");
    expect(written).not.toContain("remote.example");
    expect(written).not.toContain("other.example");
    expect(written).not.toContain("crlf.example");
    expect(written).not.toContain("dry-run");
    expect(written).toContain("KEEP=1");
    expect(written).toContain("postgresql://app_owner:app_owner@localhost:");
    expect(written).toContain("/lane_zzorch");
    const child = readFileSync(log, "utf8");
    expect(child).toContain("psql");
    expect(child).toContain("child npx host=localhost");
    expect(child).not.toContain("unpooled=present");
    expect(child).not.toContain("prune=present");
    expect(child).not.toContain("secret=present");
    expect(child).not.toContain(SECRET);
    } finally {
      removeTemp(dir);
    }
  });

  it("harness log check rejects a leaked child env and a copied secret", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "t225-check-"));
    try {
      const bashPath = (file: string) => file.replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);
      const clean = ["child npx host=localhost", "child claude", "child review", "psql", "git fetch", ""].join("\n");
      const files: Array<[string, string]> = [
        ["clean", clean],
        ["secretpresent", `${clean}secret=present\n`],
        ["accesspresent", `${clean}access=present\n`],
        ["unpooledpresent", `${clean}unpooled=present\n`],
        ["prunepresent", `${clean}prune=present\n`],
        ["copied", `${clean}${SECRET}\n`],
        ["missing", clean.replace("git fetch\n", "")],
      ];
      for (const [name, body] of files) writeFileSync(path.join(dir, name), body);
      const root = bashPath(dir);
      await runCommand(gitBash(), ["-c", `
        check() { ${harnessLogCheck()} }
        runone() {
          HARNESS_LOG="$1"
          want="$2"
          err=$(check 2>&1 >/dev/null)
          rc=$?
          if [ "$want" = ok ]; then
            [ "$rc" = 0 ] || { echo "clean failed:$err" >&2; exit 1; }
            return 0
          fi
          [ "$rc" != 0 ] || { echo "should have failed" >&2; exit 1; }
          case "$err" in
            *"$want"*) ;;
            *) echo "wanted [$want] in [$err]" >&2; exit 1 ;;
          esac
        }
        runone "${root}/clean" ok
        runone "${root}/secretpresent" "leaked child env"
        runone "${root}/accesspresent" "leaked child env"
        runone "${root}/unpooledpresent" "leaked child env"
        runone "${root}/prunepresent" "leaked child env"
        runone "${root}/copied" "secret in log"
        runone "${root}/missing" "missing:git fetch"
      `], { timeoutMs: 8_000 });
    } finally {
      removeTemp(dir);
    }
  });

  it("build resume and continue run the real scripts and keep secrets out of every child", async (ctx) => {
    const started = Date.now();
    const checkoutSession = path.join(process.cwd(), ".builder", "session-225.txt");
    const sessionBefore = existsSync(checkoutSession) ? readFileSync(checkoutSession) : null;
    const dir = mkdtempSync(path.join(tmpdir(), "t225-orch-"));
    try {
    const root = path.join(dir, "repo");
    const bin = path.join(dir, "bin");
    const data = path.join(dir, "pg");
    const wt = path.join(dir, "wt");
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    mkdirSync(bin);
    mkdirSync(data);
    mkdirSync(path.join(wt, "node_modules"), { recursive: true });
    for (const name of ["build-ticket.sh", "lane-env.sh", "lane-env.mjs", "lane-db.sh", "local-pg.sh", "agent-cli.sh", "agent-engine.env", "ticket-env.txt"]) {
      copyFileSync(path.join(process.cwd(), "scripts", name), path.join(root, "scripts", name));
    }
    writeFileSync(path.join(root, ".env.local"), [
      "DATABASE_URL=postgresql://app_owner:app_owner@localhost:5434/lane_t225",
      "DIRECT_URL=postgresql://app_owner:app_owner@localhost:5434/lane_t225",
      "APP_RUNTIME_PASSWORD=app_runtime_ci",
      `R2_ACCESS_KEY_ID: ${ACCESS}`,
      `R2_SECRET_ACCESS_KEY: ${SECRET}`,
      `DATABASE_URL_UNPOOLED: postgresql://user:${SECRET}@remote.example/db`,
      "SEED_PRUNE_R2: dry-run",
      "",
    ].join("\n"));
    writeFileSync(path.join(data, "PG_VERSION"), "18\n");
    const log = path.join(dir, "log");
    writeFileSync(log, "");
    const bashPath = (file: string) => file.replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);
    const stub = (name: string, body: string) => installStub(bin, name, body);
    stub("git", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "rev-parse") { process.stdout.write(${JSON.stringify(bashPath(root))} + "\\n"); process.exit(0); }
fs.appendFileSync(process.env.HARNESS_LOG, "git " + args.join(" ") + "\\n");
process.exit(0);
`);
    stub("psql", nodePsql);
    stub("pg_ctl", nodeExit);
    stub("pg_isready", nodeExit);
    stub("npx", `${nodeChild("npx")}process.exit(0);\n`);
    stub("claude", `${nodeChild("claude")}process.stdout.write('{"session_id":"stub-session-0001"}\\n');\nprocess.exit(0);\n`);
    stub("gh", `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args.includes("blocked_by")) process.exit(0);
if (args.includes("comments")) { process.stdout.write("agent brief\\n"); process.exit(0); }
if (args.includes("title")) { process.stdout.write("seed photos\\n"); process.exit(0); }
process.stdout.write("OPEN\\n");
process.exit(0);
`);
    installWinUtils(bin);
    const review = path.join(dir, "review.sh");
    writeFileSync(review, bashChild("review", 'echo "VERDICT: PASS"\nexit 0'));
    chmodSync(review, 0o755);
    // build-ticket.sh runs local-ci beside each review. Without a stub it would call a missing ci-local.sh,
    // count that as a CI failure and loop through every fix round.
    const ciLocal = path.join(dir, "ci-local.sh");
    writeFileSync(ciLocal, bashChild("ci", 'echo "local-ci PASSED on stub"\nexit 0'));
    chmodSync(ciLocal, 0o755);
    const script = `
      set -euo pipefail
      export PATH="${commandPath(bin)}"
      export AGENT_ENGINE=claude
      export REVIEW_ENGINE=claude
      export PGBIN="${bashPath(bin)}"
      export LANE_PG_DATA="${bashPath(data)}"
      export WT="${bashPath(wt)}"
      export HARNESS_LOG="${bashPath(log)}"
      export STUB_GIT_ROOT='${bashPath(root).replaceAll("/", "|")}'
      export REVIEW_TICKET="${bashPath(review)}"
      export CI_LOCAL="${bashPath(ciLocal)}"
      export R2_SECRET_ACCESS_KEY='${SECRET}'
      export R2_ACCESS_KEY_ID='${ACCESS}'
      export SEED_PRUNE_R2='dry-run'
      export DATABASE_URL_UNPOOLED='postgresql://user:${SECRET}@remote.example/db'
      check() {
        ${harnessLogCheck()}
      }
      : > "$HARNESS_LOG"
      bash scripts/build-ticket.sh 225
      check
      : > "$HARNESS_LOG"
      bash scripts/build-ticket.sh 225 --resume "findings"
      check
      : > "$HARNESS_LOG"
      bash scripts/build-ticket.sh 225 --continue
      check
      echo modes-ok
    `;
    // Async so a long run cannot freeze the Vitest worker. The 180 s budget is unchanged.
    const { stdout } = await runCommand(gitBash(), ["-c", script], {
      cwd: root,
      env: { ...process.env, AGENT_ENGINE: "claude" },
      timeoutMs: commandBudget(started, 180_000),
      signal: ctx.signal,
    });
    expect(stdout).toContain("modes-ok");
    expect(stdout).not.toContain("Still blocking");
    expect(stdout).not.toContain(SECRET);
    expect(readFileSync(path.join(root, ".builder", "session-225.txt"), "utf8")).toBe("stub-session-0001");
    const sessionAfter = existsSync(checkoutSession) ? readFileSync(checkoutSession) : null;
    expect(sessionAfter).toEqual(sessionBefore);
    } finally {
      removeTemp(dir);
    }
  }, 180_000);
});
