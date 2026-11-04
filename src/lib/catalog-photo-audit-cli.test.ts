import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, type AuditDeps } from "./catalog-photo-audit-cli";
import { redactSecrets, RUNTIME_KEYS, type RuntimeConfig } from "./catalog-photo-audit-env";
import type { AuditProduct, HeadResult } from "./catalog-photo-audit";

const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const entry = path.join(process.cwd(), "scripts", "audit-catalog-photos.ts");

const inertEnv = {
  DATABASE_URL: "postgresql://app_runtime:super-secret-pw@db.example.com:5432/neondb",
  APP_RUNTIME_PASSWORD: "super-secret-pw",
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "access-key-id",
  R2_SECRET_ACCESS_KEY: "secret-access-key",
  R2_BUCKET: "photo-bucket",
};

function memoryStream() {
  let data = "";
  return {
    text: () => data,
    write(chunk: string, cb?: (err?: Error | null) => void) {
      data += String(chunk);
      cb?.();
      return true;
    },
    on() {},
    off() {},
  };
}

function failingStream() {
  return {
    write(_chunk: string, cb?: (err?: Error | null) => void) {
      cb?.(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      return true;
    },
    on() {},
    off() {},
  };
}

function baseChildEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    PATHEXT: process.env.PATHEXT,
    SystemRoot: process.env.SystemRoot,
    windir: process.env.windir,
    COMSPEC: process.env.COMSPEC,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    NODE_ENV: "test",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function spawnEntry(overrides: Record<string, string | undefined>) {
  return spawn(process.execPath, [tsxCli, entry], {
    env: baseChildEnv(overrides),
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function collect(child: ChildProcess, timeoutMs = 20000) {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out stdout=${stdout.slice(0, 180)} stderr=${stderr.slice(0, 240)}`));
    }, timeoutMs);
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return { code, stdout, stderr };
}

function deps(partial: Partial<AuditDeps> & Pick<AuditDeps, "readProducts">): (config: RuntimeConfig) => Promise<AuditDeps> {
  return async () => ({
    openR2: async () => ({
      bucket: "photo-bucket",
      headBucket: async () => undefined,
      headObject: async (): Promise<HeadResult> => "present",
    }),
    close: async () => undefined,
    ...partial,
  });
}

describe("catalog photo audit CLI", () => {
  const previousTz = process.env.TZ;
  afterEach(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });

  it.each(RUNTIME_KEYS)("exits non-zero listing every missing env name before loading deps (%s)", async (missing) => {
    const env = { ...inertEnv } as Record<string, string | undefined>;
    env[missing] = "";
    const result = await collect(spawnEntry(env));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`Missing environment: ${missing}`);
    expect(result.stderr).not.toMatch(/\n\s+at /);
    expect(result.stderr).not.toContain("app must connect as app_runtime");
    expect(result.stdout).toBe("");
  });

  it("all seven runtime names are checked and DIRECT_URL is not required (E18, E26)", async () => {
    const cleared = Object.fromEntries(RUNTIME_KEYS.map((key) => [key, ""])) as Record<string, string | undefined>;
    const allMissing = await collect(spawnEntry({
      ...cleared,
      NODE_ENV: "production",
      VERCEL: "1",
      NEXT_PHASE: "phase-production-build",
    }));
    expect(allMissing.code).not.toBe(0);
    for (const key of RUNTIME_KEYS) expect(allMissing.stderr).toContain(key);
    expect(allMissing.stderr).not.toContain("DIRECT_URL");
    expect(allMissing.stderr).not.toMatch(/\n\s+at /);

    const buildPhase = await collect(spawnEntry({
      ...inertEnv,
      APP_RUNTIME_PASSWORD: "",
      NODE_ENV: "production",
      NEXT_PHASE: "phase-production-build",
      VERCEL: "1",
    }));
    expect(buildPhase.code).not.toBe(0);
    expect(buildPhase.stderr).toContain("APP_RUNTIME_PASSWORD");
    expect(buildPhase.stderr).not.toContain("falling back");
    expect(buildPhase.stderr).not.toContain("app must connect as app_runtime");
  });

  it("NODE_ENV=production without APP_RUNTIME_PASSWORD fails with the env message (E19)", async () => {
    const result = await collect(spawnEntry({
      ...inertEnv,
      APP_RUNTIME_PASSWORD: undefined,
      NODE_ENV: "production",
    }));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Missing environment: APP_RUNTIME_PASSWORD");
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });

  it("rejects a malformed DATABASE_URL without echoing it", async () => {
    const result = await collect(spawnEntry({
      ...inertEnv,
      DATABASE_URL: "not-a-url super-secret-value",
    }));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("DATABASE_URL is not a valid database URL");
    expect(result.stderr.includes("super-secret-value")).toBe(false);
  });

  it("main prints no row list and names key and status on provider failure (AC3)", async () => {
    const stdout = memoryStream();
    const stderr = memoryStream();
    let opened = false;
    const code = await main({
      env: inertEnv,
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
      loadDeps: deps({
        readProducts: async () => Array.from({ length: 20 }, (_, index) => ({
          id: `id-${index}`,
          name: `Name ${index}`,
          status: "active",
          imageUrl: `catalog/k${index}.webp`,
        })),
        openR2: async () => {
          opened = true;
          return {
            bucket: "photo-bucket",
            headBucket: async () => undefined,
            headObject: async (key) => {
              if (key === "catalog/k3.webp") {
                throw Object.assign(new Error("denied"), { name: "Unknown", $metadata: { httpStatusCode: 403 } });
              }
              return "missing" as const;
            },
          };
        },
      }),
    });
    expect(opened).toBe(true);
    expect(code).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("HeadObject failed for catalog/k3.webp: HTTP 403");
    expect(stderr.text()).not.toContain("R2 HeadObject returned 404");
  });

  it("DB failure prevents R2 preflight and emits only sanitized diagnostics (E5)", async () => {
    const stdout = memoryStream();
    const stderr = memoryStream();
    let opened = false;
    const code = await main({
      env: inertEnv,
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
      loadDeps: deps({
        readProducts: async () => {
          throw new Error("connect failed postgresql://app_runtime:super-secret-pw@db.example.com/neondb");
        },
        openR2: async () => {
          opened = true;
          throw new Error("should not open");
        },
      }),
    });
    expect(code).toBe(1);
    expect(opened).toBe(false);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("Database read failed");
    expect(stderr.text().includes("super-secret-pw")).toBe(false);
    expect(stderr.text().includes("postgresql://")).toBe(false);
  });

  it("main prints header, rows and counts and exits 0 when photos are missing (AC6, E10, E11)", async () => {
    process.env.TZ = "America/Denver";
    const stdout = memoryStream();
    const stderr = memoryStream();
    const times = [new Date("2026-11-04T18:00:00.000Z"), new Date("2026-11-04T18:00:04.000Z")];
    let tick = 0;
    let headObjects = 0;
    let headBuckets = 0;
    const code = await main({
      env: { ...inertEnv, DIRECT_URL: undefined },
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
      now: () => times[tick++] ?? times[1]!,
      loadDeps: deps({
        readProducts: async () => [{ id: "1", name: "Biltong", status: "active", imageUrl: "catalog/biltong.jpg" }],
        openR2: async () => ({
          bucket: "photo-bucket",
          headBucket: async () => { headBuckets += 1; },
          headObject: async () => {
            headObjects += 1;
            return "missing" as const;
          },
        }),
      }),
    });
    expect(code).toBe(0);
    expect(headBuckets).toBe(1);
    expect(headObjects).toBe(1);
    const text = stdout.text();
    expect(text).toContain("missing | Biltong | 1 | active | catalog/biltong.jpg | jpg | R2 HeadObject returned 404");
    expect(text).toContain("counts ok=0 missing=1 invalid-key=0 not-r2=0 no-image=0");
    expect(text).toContain("missing-extensions jpg=1");
    expect(text).toContain("1 checked");
    expect(text).toContain("db-read: 2026-11-04T18:00:00.000Z");
    expect(text).toContain("completed: 2026-11-04T18:00:04.000Z");
    expect(text).toContain("db-host: db.example.com");
    expect(text).toContain("bucket: photo-bucket");
    expect(text).toContain("not an atomic snapshot");
    expect(text).not.toMatch(/[+-]\d{2}:\d{2}/);
    expect(text.includes("super-secret-pw")).toBe(false);
    expect(text.includes("secret-access-key")).toBe(false);
    expect(stderr.text()).toBe("");

    const emptyOut = memoryStream();
    let emptyHeads = 0;
    const emptyCode = await main({
      env: inertEnv,
      stdout: emptyOut as unknown as NodeJS.WritableStream,
      stderr: memoryStream() as unknown as NodeJS.WritableStream,
      now: () => new Date("2026-11-04T00:00:00.000Z"),
      loadDeps: deps({
        readProducts: async () => [{ id: "1", name: "Bare", status: "active", imageUrl: "  " }],
        openR2: async () => ({
          bucket: "photo-bucket",
          headBucket: async () => { emptyHeads += 1; },
          headObject: async () => { throw new Error("no key to check"); },
        }),
      }),
    });
    expect(emptyCode).toBe(0);
    expect(emptyHeads).toBe(1);
    expect(emptyOut.text()).toContain("0 checked");
    expect(emptyOut.text()).toContain("no-image=1");
    expect(emptyOut.text()).not.toContain("Bare");
  });

  it("serializes control characters and reconciles duplicate-row counts (E31, E32)", async () => {
    const stdout = memoryStream();
    const products: AuditProduct[] = [
      ...Array.from({ length: 15 }, (_, index) => ({
        id: `leaf-${index}`,
        name: `Leaf ${index}`,
        status: "active",
        imageUrl: "catalog/storefront-test.jpg",
      })),
      {
        id: "odd",
        name: "A\nB\tC\u001b[31m",
        status: "active",
        imageUrl: "catalog/ok.webp",
      },
    ];
    const code = await main({
      env: inertEnv,
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: memoryStream() as unknown as NodeJS.WritableStream,
      now: () => new Date("2026-11-04T00:00:00.000Z"),
      loadDeps: deps({
        readProducts: async () => products,
        openR2: async () => ({
          bucket: "photo-bucket",
          headBucket: async () => undefined,
          headObject: async (key) => (key.endsWith(".jpg") ? "missing" as const : "present" as const),
        }),
      }),
    });
    expect(code).toBe(0);
    const text = stdout.text();
    expect(text.includes("\u001b")).toBe(false);
    expect(text).toContain("A\\nB\\tC\\u001b[31m");
    expect(text.split("\n").some((line) => line.startsWith("B"))).toBe(false);
    expect(text).toContain("missing=15");
    expect(text).toContain("jpg=15");
    expect(text).toContain("2 checked");
  });

  it("output write failure exits nonzero and terminates (E22)", async () => {
    const code = await main({
      env: inertEnv,
      stdout: failingStream() as unknown as NodeJS.WritableStream,
      stderr: memoryStream() as unknown as NodeJS.WritableStream,
      now: () => new Date("2026-11-04T00:00:00.000Z"),
      loadDeps: deps({
        readProducts: async () => [{ id: "1", name: "Yam", status: "active", imageUrl: "catalog/yam.webp" }],
      }),
    });
    expect(code).toBe(1);
  });

  it("real wrapper flushes a report larger than a pipe buffer before exit (E22)", async () => {
    const fixture = path.join(tmpdir(), `catalog-audit-large-${process.pid}.ts`);
    writeFileSync(fixture, `
      export async function loadDeps() {
        const products = Array.from({ length: 4000 }, (_, index) => ({
          id: "id-" + index,
          name: "Product " + String(index).padStart(4, "0") + " ${"x".repeat(60)}",
          status: "active",
          imageUrl: "/api/catalog-image/catalog/p" + index + ".webp",
        }));
        return {
          readProducts: async () => products,
          openR2: async () => ({
            bucket: "photo-bucket",
            headBucket: async () => undefined,
            headObject: async () => "missing",
          }),
          close: async () => undefined,
        };
      }
    `);
    const child = spawnEntry({ ...inertEnv, CATALOG_PHOTO_AUDIT_FIXTURE: fixture });
    child.stdout?.pause();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(child.exitCode).toBeNull();
    const pending = collect(child, 30000);
    child.stdout?.resume();
    const result = await pending;
    expect(result.code).toBe(0);
    const xs = "x".repeat(60);
    const rows = Array.from({ length: 4000 }, (_, index) => {
      const name = `Product ${String(index).padStart(4, "0")} ${xs}`;
      return `missing | ${name} | id-${index} | active | catalog/p${index}.webp | webp | R2 HeadObject returned 404`;
    });
    const trailer = [
      "counts ok=0 missing=4000 invalid-key=0 not-r2=0 no-image=0",
      "missing-extensions webp=4000",
      "4000 checked",
      "db-read: TIMESTAMP",
      "completed: TIMESTAMP",
      "db-host: db.example.com",
      "bucket: photo-bucket",
      "note: R2 results are observations between db-read and completed, not an atomic snapshot",
      "",
    ];
    expect(result.stdout).toMatch(/db-read: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    expect(result.stdout).toMatch(/completed: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    const normalized = result.stdout
      .replace(/db-read: .*/g, "db-read: TIMESTAMP")
      .replace(/completed: .*/g, "completed: TIMESTAMP");
    expect(normalized).toBe([...rows, ...trailer].join("\n"));
  });

  it("a broken stdout pipe exits nonzero", async () => {
    const fixture = path.join(tmpdir(), `catalog-audit-epipe-${process.pid}.ts`);
    writeFileSync(fixture, `
      export async function loadDeps() {
        const products = Array.from({ length: 2000 }, (_, index) => ({
          id: "id-" + index,
          name: "Product " + index + " ${"y".repeat(80)}",
          status: "active",
          imageUrl: "catalog/p" + index + ".webp",
        }));
        return {
          readProducts: async () => products,
          openR2: async () => ({
            bucket: "photo-bucket",
            headBucket: async () => undefined,
            headObject: async () => "present",
          }),
          close: async () => undefined,
        };
      }
    `);
    const child = spawnEntry({ ...inertEnv, CATALOG_PHOTO_AUDIT_FIXTURE: fixture });
    child.stdout?.destroy();
    const result = await collect(child, 20000);
    expect(result.code).not.toBe(0);
  });

  it("redacts every nonempty configured secret, including short passwords (E31)", async () => {
    expect(redactSecrets("password pw123 rejected", ["pw123"])).toBe("password [redacted] rejected");
    const stderr = memoryStream();
    const code = await main({
      env: { ...inertEnv, APP_RUNTIME_PASSWORD: "pw123" },
      stdout: memoryStream() as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
      loadDeps: async () => ({
        readProducts: async () => {
          throw new Error("password pw123 rejected");
        },
        openR2: async () => {
          throw new Error("R2 should not open");
        },
        close: async () => undefined,
      }),
    });
    expect(code).toBe(1);
    expect(stderr.text()).toBe("Database read failed: password [redacted] rejected\n");
  });

  it("DIRECT_URL is absent and the actual runtime loader still succeeds (E19, E26)", async () => {
    if (!process.env.DATABASE_URL || !process.env.APP_RUNTIME_PASSWORD) return;
    const head = path.join(tmpdir(), `catalog-audit-head-${process.pid}.ts`);
    writeFileSync(head, `
      export function createHead() {
        return {
          bucket: "photo-bucket",
          headBucket: async () => undefined,
          headObject: async () => "present",
          close() {},
        };
      }
    `);
    const result = await collect(spawnEntry({
      DATABASE_URL: process.env.DATABASE_URL,
      APP_RUNTIME_PASSWORD: process.env.APP_RUNTIME_PASSWORD,
      R2_ACCOUNT_ID: "acct",
      R2_ACCESS_KEY_ID: "access-key-id",
      R2_SECRET_ACCESS_KEY: "secret-access-key",
      R2_BUCKET: "photo-bucket",
      NODE_ENV: "production",
      CATALOG_PHOTO_AUDIT_HEAD: head,
      TZ: "America/Denver",
    }), 30000);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("db-host:");
    expect(result.stdout).toContain("db-read:");
    expect(result.stdout).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    expect(result.stdout).toContain("not an atomic snapshot");
    expect(result.stderr.includes(process.env.APP_RUNTIME_PASSWORD)).toBe(false);
    expect(result.stdout.includes(process.env.APP_RUNTIME_PASSWORD)).toBe(false);
    expect(result.stdout.includes(process.env.DATABASE_URL)).toBe(false);
    expect(result.stderr).not.toContain("DIRECT_URL");
  });
});
