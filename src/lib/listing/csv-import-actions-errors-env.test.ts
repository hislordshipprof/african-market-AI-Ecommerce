import { CSV_COMMIT_REQUIRED_KEYS } from "./csv-commit-prod-guard";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { authPrisma } from "../db";
import {
  AUTH_IP_ENV,
  AUTH_PATHS,
  type IdentityPathEvidence,
  deleteRateLimitsForIdentity,
  findUnscopedRateLimitDeletes,
  freshRateLimitIpv4,
  futureRequestStamp,
  IDENTITY_EVIDENCE_PREFIX,
  isSingleIpv4,
  rateLimitSourceFiles,
  readIdentityEvidence,
  replaceIdentityDeleterForTests,
  runProcess,
  runProductionAttempt,
  type SpawnResult,
  stripCommentsAndStrings,
  unscopedRateLimitDeletesInSources,
  WINDOW_RESET_PREFIX,
} from "./csv-commit-rate-limit-harness";

const vitestEntry = path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
const suite = "src/lib/listing/csv-import-actions-errors.integration.test.ts";
const REQUIRED_KEYS = CSV_COMMIT_REQUIRED_KEYS;
const PRODUCTION_TEST = "production error mapping is unchanged with Vercel flags absent and present";
const NO_MATCH_FILTER = "csv commit identity guard does not run the suite";
const CHILD_TIMEOUT_MS = 240_000;
const databaseUrl = process.env.DATABASE_URL;
const hasLaneDb = typeof databaseUrl === "string" && databaseUrl.trim() !== "";

function requireLaneDb(): void {
  if (!hasLaneDb) throw new Error("csv commit error suite requires DATABASE_URL");
}

const dbDescribe = !hasLaneDb && process.env.CI ? describe : describe.skipIf(!hasLaneDb);

function childEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function runSuite(overrides: Record<string, string | undefined>, extraArgs: string[] = [], timeoutMs = 60_000) {
  return runProcess(process.execPath, [vitestEntry, "run", suite, "--reporter=verbose", ...extraArgs], {
    cwd: process.cwd(),
    env: childEnv(overrides),
    timeoutMs,
  });
}

function productionOverrides(
  identity: string,
  mode: "absent" | "present",
): Record<string, string | undefined> {
  return {
    NODE_ENV: "production",
    CI: "true",
    AUTH_RATE_LIMIT_RELAXED: "1",
    CSV_COMMIT_PROD_CHECK: "1",
    [AUTH_IP_ENV]: identity,
    VERCEL: mode === "present" ? "1" : undefined,
    VERCEL_ENV: mode === "present" ? "production" : undefined,
    CSV_COMMIT_EXPECT_VERCEL: mode === "present" ? "1" : undefined,
    CSV_COMMIT_OMITTED_KEYS: undefined,
  };
}

interface RateRow {
  id: string;
  key: string;
  count: number;
  lastRequest: bigint;
}

async function insertRow(key: string, count: number): Promise<RateRow> {
  return authPrisma.rateLimit.create({
    data: { key, count, lastRequest: futureRequestStamp() },
  });
}

async function readRow(id: string): Promise<RateRow | null> {
  return authPrisma.rateLimit.findUnique({ where: { id } });
}

function expectSameRow(row: RateRow | null, expected: RateRow): void {
  expect(row).toBeTruthy();
  expect(row?.id).toBe(expected.id);
  expect(row?.key).toBe(expected.key);
  expect(row?.count).toBe(expected.count);
  expect(row?.lastRequest.toString()).toBe(expected.lastRequest.toString());
}

async function deleteExact(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await authPrisma.rateLimit.deleteMany({ where: { key: { in: keys } } });
}

const FALLBACK_OWNERS = ["127.0.0.1", "no-trusted-ip"];

async function fallbackSnapshot(): Promise<IdentityPathEvidence[]> {
  const keys = FALLBACK_OWNERS.flatMap((owner) => AUTH_PATHS.map((authPath) => `${owner}|${authPath}`));
  const rows = await authPrisma.rateLimit.findMany({ where: { key: { in: keys } } });
  return rows.map((row) => ({ key: row.key, count: row.count, lastRequest: row.lastRequest.toString() }));
}

function expectFallbackUnchanged(before: IdentityPathEvidence[], after: IdentityPathEvidence[]): void {
  const created = after.filter((row) => !before.some((prior) => prior.key === row.key));
  expect(created).toEqual([]);
  for (const prior of before) {
    const next = after.find((row) => row.key === prior.key);
    if (!next) {
      expect(Number(prior.lastRequest)).toBeLessThan(Date.now() - 60_000);
      continue;
    }
    expect(next.count).toBe(prior.count);
    expect(next.lastRequest).toBe(prior.lastRequest);
  }
}

function expectEvidence(output: string, identity: string): void {
  const parsed = readIdentityEvidence(output);
  expect(parsed.ip).toBe(identity);
  for (const authPath of AUTH_PATHS) {
    const row = parsed.evidence[authPath];
    expect(row?.key).toBe(`${identity}|${authPath}`);
    expect(row?.count).toBeGreaterThan(0);
  }
  expect(output).toContain(`${WINDOW_RESET_PREFIX}${identity}|/sign-in/email`);
}

describe("csv commit action error suite env", () => {
  it("required integration invocation fails for each missing required key", async () => {
    for (const key of REQUIRED_KEYS) {
      const result = await runSuite({ REQUIRE_CSV_COMMIT_ERRORS: "1", [key]: "" });
      expect(result.status, result.output.slice(-2500)).not.toBe(0);
      expect(result.output).toContain(`csv commit error suite requires ${key}`);
      expect(result.output).not.toMatch(/Tests\s+\d+\s+passed/);
      expect(result.output).not.toMatch(/\d+ skipped/);
    }
  }, 180_000);

  it("no test deletes every rate_limits row", () => {
    const unsafe = [
      "authPrisma.rateLimit.deleteMany({})",
      "authPrisma.rateLimit.deleteMany()",
      "db.rateLimit.deleteMany({ where: {} })",
      "db.rateLimit.deleteMany({\n  where: {}\n})",
      "await tx.rateLimit.deleteMany({ where: { id: row.id } })",
      "`\nDELETE FROM rate_limits\n`",
      'DELETE FROM "rate_limits"',
    ];
    for (const source of unsafe) {
      expect(findUnscopedRateLimitDeletes(source).length, source).toBeGreaterThan(0);
    }
    const safe = [
      "authPrisma.rateLimit.deleteMany({ where: { key: { startsWith: `${ip}|` } } })",
      "rawPrisma.rateLimit.deleteMany({\n  where: { key: { startsWith: \"invite:\" } },\n})",
      "DELETE FROM rate_limits WHERE key = 'kept'",
      "DELETE FROM \"rate_limits\" a USING \"rate_limits\" b WHERE a.id = b.id",
    ];
    for (const source of safe) {
      expect(findUnscopedRateLimitDeletes(source), source).toEqual([]);
    }
    const ownSource = stripCommentsAndStrings(
      readFileSync(new URL("./csv-import-actions-errors-env.test.ts", import.meta.url), "utf8"),
    );
    expect(findUnscopedRateLimitDeletes(ownSource)).toEqual([]);
    const scratch = mkdtempSync(path.join(tmpdir(), "csv-commit-sql-"));
    try {
      const scanned: Array<[string, string, boolean]> = [
        ["unsafe-call.test.ts", "await authPrisma.$executeRawUnsafe('DELETE FROM \"rate_limits\"');\n", true],
        ["unsafe-tag.test.ts", "await authPrisma.$executeRaw`\nDELETE FROM \"rate_limits\"\n`;\n", true],
        [
          "keyed.test.ts",
          "await authPrisma.rateLimit.deleteMany({ where: { key: { startsWith: \"10.1.2.3|\" } } });\n",
          false,
        ],
        [
          "where.test.ts",
          "await authPrisma.$executeRawUnsafe('DELETE FROM rate_limits WHERE key = \\'kept\\'');\n",
          false,
        ],
        ["comment.test.ts", "// DELETE FROM rate_limits\nconst note = 'DELETE FROM rate_limits';\n", false],
      ];
      for (const [name, body, unsafe] of scanned) {
        const file = path.join(scratch, name);
        writeFileSync(file, body);
        const hits = unscopedRateLimitDeletesInSources([file]);
        if (unsafe) expect(hits, body).not.toEqual([]);
        else expect(hits, body).toEqual([]);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    expect(unscopedRateLimitDeletesInSources(rateLimitSourceFiles())).toEqual([]);
    const ticketEnv = readFileSync(path.join(process.cwd(), "scripts", "ticket-env.txt"), "utf8");
    expect(ticketEnv).toMatch(/^233 DATABASE_URL DIRECT_URL APP_RUNTIME_PASSWORD BETTER_AUTH_SECRET$/m);
  });

  it("parent prerequisites fail before database clients start", async () => {
    const envFile = "src/lib/listing/csv-import-actions-errors-env.test.ts";
    const filter = ["-t", "no test deletes every rate_limits row"];
    for (const value of ["   ", "\t", ""]) {
      const result = await runProcess(
        process.execPath,
        [vitestEntry, "run", envFile, "--reporter=verbose", ...filter],
        { cwd: process.cwd(), env: childEnv({ CI: "true", DATABASE_URL: value }), timeoutMs: 60_000 },
      );
      expect(result.status, result.output.slice(-1500)).not.toBe(0);
      expect(result.output).toContain("csv commit error suite requires DATABASE_URL");
      expect(result.output).not.toContain("Invalid URL");
      expect(result.output).not.toMatch(/Tests\s+\d+\s+passed/);
    }
    const local = await runProcess(
      process.execPath,
      [vitestEntry, "run", envFile, "--reporter=verbose", ...filter],
      { cwd: process.cwd(), env: childEnv({ CI: undefined, DATABASE_URL: "" }), timeoutMs: 60_000 },
    );
    expect(local.status, local.output.slice(-1500)).toBe(0);
    expect(local.output).toMatch(/Tests\s+1\s+passed/);
  }, 180_000);

  dbDescribe("lane database", () => {
    const leftoverKeys: string[] = [];

    afterAll(async () => {
      await deleteExact(leftoverKeys);
    });

    it(PRODUCTION_TEST, async () => {
      requireLaneDb();
      const runId = `t233-${Date.now()}-${crypto.randomUUID()}`;
      const absentIp = freshRateLimitIpv4();
      let presentIp = freshRateLimitIpv4();
      const neighborKey = (ip: string) => `${ip}0|/sign-up/email`;
      while (
        presentIp === absentIp ||
        neighborKey(absentIp).startsWith(`${presentIp}|`) ||
        neighborKey(presentIp).startsWith(`${absentIp}|`)
      ) {
        presentIp = freshRateLimitIpv4();
      }
      const sentinelA = await insertRow(`t233-sentinel:${runId}`, 4);
      leftoverKeys.push(sentinelA.key);
      const sentinelBKeys = [neighborKey(absentIp), neighborKey(presentIp)];
      const sentinelBs = [];
      for (const key of sentinelBKeys) {
        sentinelBs.push(await insertRow(key, 2));
        leftoverKeys.push(key);
      }

      try {
        const seen = new Set<string>();
        for (const [mode, identity, neighbor] of [
          ["absent", absentIp, sentinelBs[0]!],
          ["present", presentIp, sentinelBs[1]!],
        ] as const) {
          const beforeFallback = await fallbackSnapshot();
          let spawns = 0;
          const result = await runProductionAttempt({
            identity,
            spawn: () => {
              spawns += 1;
              return runSuite(
                productionOverrides(identity, mode),
                ["-t", PRODUCTION_TEST],
                CHILD_TIMEOUT_MS,
              );
            },
            observe: async (child) => {
              expect(child.status, child.output.slice(-2500)).toBe(0);
              expect(child.output).toContain(PRODUCTION_TEST);
              expect(child.output).toMatch(/Tests\s+1 passed/);
              expect(child.output).not.toContain("Too many requests");
              expect(child.timedOut).toBe(false);
              expectEvidence(child.output, identity);
              expectFallbackUnchanged(beforeFallback, await fallbackSnapshot());
              const signIn = await authPrisma.rateLimit.findUnique({ where: { key: `${identity}|/sign-in/email` } });
              expect(signIn?.key).toBe(`${identity}|/sign-in/email`);
              expectSameRow(await readRow(sentinelA.id), sentinelA);
              expectSameRow(await readRow(neighbor.id), neighbor);
            },
          });
          expect(spawns).toBe(1);
          expect(result.status).toBe(0);
          seen.add(identity);
          expect(await authPrisma.rateLimit.count({ where: { key: { startsWith: `${identity}|` } } })).toBe(0);
          expectSameRow(await readRow(sentinelA.id), sentinelA);
          expectSameRow(await readRow(neighbor.id), neighbor);
        }
        expect(seen.size).toBe(2);
        expectSameRow(await readRow(sentinelA.id), sentinelA);
        const updated = await authPrisma.rateLimit.updateMany({
          where: { id: sentinelA.id },
          data: { count: 5 },
        });
        expect(updated.count).toBe(1);
      } finally {
        await deleteExact(leftoverKeys);
      }
    }, 600_000);

    it("production child without a valid rate-limit identity fails closed", async () => {
      requireLaneDb();
      const invalid: Array<string | undefined> = [
        undefined,
        "",
        "   ",
        "\t",
        "10.1.2.3, 10.1.2.4",
        "not-an-ip",
        "10.1.2.256",
        "10.01.2.3",
        "10.1.2.3/32",
        "10.1.2.3:80",
        "::1",
        "::ffff:10.1.2.3",
        "10.1.2.3 ",
        "10.1.2.3%",
        "10.1.2._",
      ];
      for (const value of invalid) {
        expect(isSingleIpv4(value)).toBe(false);
        const result = await runSuite(
          {
            ...productionOverrides("10.9.9.9", "absent"),
            [AUTH_IP_ENV]: value,
          },
          ["-t", NO_MATCH_FILTER],
        );
        expect(result.status, result.output.slice(-1500)).not.toBe(0);
        expect(result.output).toContain("csv commit error suite requires CSV_COMMIT_AUTH_IP");
        expect(result.output).not.toMatch(/Tests\s+\d+\s+passed/);
        expect(result.output).not.toMatch(/\d+ skipped/);
      }
    }, 420_000);

    it("production integration preconditions fail closed for every missing key", async () => {
      requireLaneDb();
      for (const key of REQUIRED_KEYS) {
        for (const value of ["", "   ", "\t"]) {
          const result = await runSuite(
            {
              ...productionOverrides("10.9.8.7", "absent"),
              NODE_ENV: "production",
              CI: "true",
              REQUIRE_CSV_COMMIT_ERRORS: undefined,
              [key]: value,
            },
            ["-t", NO_MATCH_FILTER],
          );
          expect(result.status, `${key}=${JSON.stringify(value)} ${result.output.slice(-1500)}`).not.toBe(0);
          expect(result.output).toContain(`csv commit error suite requires ${key}`);
          expect(result.output).not.toMatch(/Tests\s+\d+\s+passed/);
          expect(result.output).not.toMatch(/\d+ skipped/);
        }
      }
      // Deleting DATABASE_URL lets src/lib/test-setup.ts refill it from .env.local.
      // The omit probe must still fail closed instead of running the suite.
      const refilled = await runSuite(
        {
          ...productionOverrides("10.9.8.7", "absent"),
          CI: "true",
          DATABASE_URL: undefined,
          CSV_COMMIT_OMITTED_KEYS: "DATABASE_URL",
        },
        ["-t", NO_MATCH_FILTER],
      );
      expect(refilled.status, refilled.output.slice(-1500)).not.toBe(0);
      expect(refilled.output).toContain("csv commit error suite requires DATABASE_URL");
      expect(refilled.output).not.toMatch(/Tests\s+\d+\s+passed/);
      expect(refilled.output).not.toContain(IDENTITY_EVIDENCE_PREFIX);
    }, 420_000);

    it("invalid identities cannot reach rate-limit cleanup", async () => {
      requireLaneDb();
      const survivor = await insertRow(`t233-e20:${crypto.randomUUID()}`, 6);
      leftoverKeys.push(survivor.key);
      const calls: string[] = [];
      replaceIdentityDeleterForTests(async (identity) => {
        calls.push(identity);
        return 0;
      });
      try {
        for (const bad of ["", "%", "_", "::1", "10.1.2.3%", "10.1.2.3, 10.1.2.4", "   "]) {
          await expect(deleteRateLimitsForIdentity(bad)).rejects.toThrow(
            "csv commit error suite requires CSV_COMMIT_AUTH_IP",
          );
        }
        expect(calls).toEqual([]);
      } finally {
        replaceIdentityDeleterForTests(null);
      }
      expectSameRow(await readRow(survivor.id), survivor);
    });

    it("scoped cleanup runs after child and observation failures", async () => {
      requireLaneDb();
      const identity = "10.64.1.1";
      const key = `${identity}|/sign-up/email`;
      leftoverKeys.push(key);
      await insertRow(key, 1);
      await expect(runProductionAttempt({
        identity,
        spawn: async () => {
          throw new Error("runner blew up");
        },
      })).rejects.toThrow(/runner blew up/);
      expect(await authPrisma.rateLimit.findUnique({ where: { key } })).toBeNull();

      await insertRow(key, 2);
      await expect(runProductionAttempt({
        identity,
        spawn: async () => ({ status: 1, signal: null, error: null, output: "child exit 7", timedOut: false }),
        observe: async () => {
          throw new Error("observation failed");
        },
      })).rejects.toThrow(/observation failed/);
      expect(await authPrisma.rateLimit.findUnique({ where: { key } })).toBeNull();
    });

    it("cleanup errors retain child diagnostics and fail successful children", async () => {
      const success: SpawnResult = {
        status: 0,
        signal: null,
        error: null,
        output: "Tests 1 passed",
        timedOut: false,
      };
      await expect(runProductionAttempt({
        identity: "10.8.8.8",
        spawn: async () => success,
        cleanup: async () => {
          throw new Error("cleanup exploded");
        },
      })).rejects.toThrow(/cleanup exploded/);

      await expect(runProductionAttempt({
        identity: "10.8.8.9",
        spawn: async () => ({ status: 1, signal: null, error: null, output: "child boom", timedOut: false }),
        cleanup: async () => {
          throw new Error("cleanup exploded");
        },
      })).rejects.toThrow(/child boom[\s\S]*cleanup exploded/);
    });

    it("spawn failures and timeouts terminate before scoped cleanup", async () => {
      requireLaneDb();
      const missingIdentity = "10.77.8.10";
      const missingKey = `${missingIdentity}|/spawn-error`;
      leftoverKeys.push(missingKey);
      await insertRow(missingKey, 1);
      let missingSpawns = 0;
      await expect(runProductionAttempt({
        identity: missingIdentity,
        spawn: async () => {
          missingSpawns += 1;
          return runProcess(path.join(process.cwd(), "missing-csv-commit-binary"), [], {
            env: process.env,
            timeoutMs: 5_000,
          });
        },
      })).rejects.toThrow(/ENOENT|spawn/i);
      expect(missingSpawns).toBe(1);
      expect(await authPrisma.rateLimit.findUnique({ where: { key: missingKey } })).toBeNull();

      const signalIdentity = "10.77.8.11";
      const signalKey = `${signalIdentity}|/signal`;
      leftoverKeys.push(signalKey);
      await insertRow(signalKey, 1);
      await expect(runProductionAttempt({
        identity: signalIdentity,
        spawn: () => runProcess(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], {
          env: process.env,
          timeoutMs: 5_000,
        }),
      })).rejects.toThrow(/signal=|status=/);
      expect(await authPrisma.rateLimit.findUnique({ where: { key: signalKey } })).toBeNull();

      const identity = "10.77.8.9";
      const holdKey = `${identity}|/hold`;
      leftoverKeys.push(holdKey);
      const writer = `
        const { Client } = require("pg");
        const client = new Client({ connectionString: process.env.DATABASE_URL });
        const key = process.env.HOLD_KEY;
        const beat = async () => {
          const now = Date.now();
          const id = now.toString(16) + Math.random().toString(16).slice(2);
          await client.query(
            "INSERT INTO rate_limits (id, key, count, last_request) VALUES ($1, $2, 1, $3) ON CONFLICT (key) DO UPDATE SET count = rate_limits.count + 1, last_request = EXCLUDED.last_request",
            [id, key, now],
          );
        };
        client.connect().then(async () => {
          await beat();
          setInterval(() => { beat().catch(() => {}); }, 50);
        }).catch((error) => { console.error(error); process.exit(1); });
      `;
      const holder = `
        const { spawn } = require("node:child_process");
        const kid = spawn(process.execPath, ["-e", process.env.WRITER_SOURCE], {
          env: process.env,
          stdio: "inherit",
          windowsHide: true,
        });
        kid.on("exit", () => process.exit(0));
        setInterval(() => {}, 1000);
      `;
      let timeoutSpawns = 0;
      const attempt = runProductionAttempt({
        identity,
        spawn: () => {
          timeoutSpawns += 1;
          return runProcess(process.execPath, ["-e", holder], {
            env: { ...process.env, HOLD_KEY: holdKey, WRITER_SOURCE: writer },
            timeoutMs: 4_000,
          });
        },
      });
      let appeared = false;
      for (let i = 0; i < 40 && !appeared; i += 1) {
        appeared = (await authPrisma.rateLimit.findUnique({ where: { key: holdKey } })) !== null;
        if (!appeared) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(appeared).toBe(true);
      await expect(attempt).rejects.toThrow(/timedOut=true/);
      expect(timeoutSpawns).toBe(1);
      expect(await authPrisma.rateLimit.findUnique({ where: { key: holdKey } })).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(await authPrisma.rateLimit.findUnique({ where: { key: holdKey } })).toBeNull();
    }, 30_000);

    it("cleanup preserves an active neighboring identity and unrelated row contents", async () => {
      requireLaneDb();
      const near = "10.1.2.3";
      const far = "10.1.2.30";
      const nearKey = `${near}|/sign-up/email`;
      const farKey = `${far}|/sign-up/email`;
      const unrelatedKey = `t233-neighbor:${crypto.randomUUID()}`;
      leftoverKeys.push(nearKey, farKey, unrelatedKey);
      await insertRow(nearKey, 1);
      const neighbor = await insertRow(farKey, 2);
      const unrelated = await insertRow(unrelatedKey, 8);
      let releaseUpdate: () => void = () => {};
      const updateGate = new Promise<void>((resolve) => {
        releaseUpdate = resolve;
      });
      let markLocked: () => void = () => {};
      const locked = new Promise<void>((resolve) => {
        markLocked = resolve;
      });
      const hold = authPrisma.$transaction(async (tx) => {
        const current = await tx.rateLimit.findUnique({ where: { id: neighbor.id } });
        expect(current?.count).toBe(2);
        markLocked();
        await updateGate;
        const updated = await tx.rateLimit.updateMany({
          where: { id: neighbor.id },
          data: { count: 3 },
        });
        expect(updated.count).toBe(1);
      });
      await locked;
      await deleteRateLimitsForIdentity(near);
      releaseUpdate();
      await hold;
      expect(await authPrisma.rateLimit.findUnique({ where: { key: nearKey } })).toBeNull();
      const afterNeighbor = await readRow(neighbor.id);
      expect(afterNeighbor?.id).toBe(neighbor.id);
      expect(afterNeighbor?.key).toBe(farKey);
      expect(afterNeighbor?.count).toBe(3);
      expect(afterNeighbor?.lastRequest.toString()).toBe(neighbor.lastRequest.toString());
      const again = await authPrisma.rateLimit.updateMany({
        where: { id: neighbor.id },
        data: { count: 4 },
      });
      expect(again.count).toBe(1);
      expectSameRow(await readRow(unrelated.id), unrelated);
      await deleteRateLimitsForIdentity(far);
    });

    it("rate-limit failure is reported after exactly one child invocation", async () => {
      requireLaneDb();
      const identity = "10.55.1.2";
      const key = `${identity}|/sign-up/email`;
      leftoverKeys.push(key);
      await insertRow(key, 3);
      let calls = 0;
      await expect(runProductionAttempt({
        identity,
        spawn: async () => {
          calls += 1;
          return {
            status: 1,
            signal: null,
            error: null,
            output: "Too many requests. Please try again later.",
            timedOut: false,
          };
        },
      })).rejects.toThrow(/Too many requests/);
      expect(calls).toBe(1);
      expect(await authPrisma.rateLimit.findUnique({ where: { key } })).toBeNull();
    });
  });
});

