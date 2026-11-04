import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const coreProbe = path.join(process.cwd(), "src", "lib", "catalog-photo-audit-import-probe.ts");
const dbProbe = path.join(process.cwd(), "src", "lib", "catalog-photo-audit-prod-import-probe.ts");

function childEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
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

async function collect(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 20000) {
  const child = spawn(process.execPath, args, {
    env,
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("import probe timed out"));
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

describe("catalog photo audit import boundaries", () => {
  it("core imports without R2 configuration in production and VERCEL", async () => {
    const source = readFileSync(path.join(process.cwd(), "src", "lib", "catalog-photo-audit.ts"), "utf8");
    expect(source).toContain("export function httpStatusOf");
    expect(source).not.toContain("catalog-photo-audit-r2");
    expect(source).not.toContain("@aws-sdk");
    expect(source).not.toContain("@smithy");

    const result = await collect([tsxCli, coreProbe], childEnv({
      NODE_ENV: "production",
      VERCEL: "1",
    }));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("core-import-ok\n");
    expect(result.stderr).toBe("");
  });

  it("production with a partial database env fails closed instead of skipping", async () => {
    const result = await collect([tsxCli, dbProbe], childEnv({
      NODE_ENV: "production",
      VERCEL: "1",
      DATABASE_URL: "postgresql://app_runtime:not-a-secret@127.0.0.1:9/unused",
    }));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("APP_RUNTIME_PASSWORD is required in production");
    expect(result.stderr).not.toContain("falling back");
    expect(result.stderr).not.toContain("skipped");
    expect(result.stdout).not.toContain("imported-without-throw");
  });

  it("the reader suite skips when the runtime password is blank under NODE_ENV=test", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL is required to prove the suite skips");
    const suite = "src/lib/catalog-photo-audit.integration.test.ts";
    const result = await collect(
      [
        path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs"),
        "run",
        suite,
        "--reporter=json",
      ],
      childEnv({
        NODE_ENV: "test",
        DATABASE_URL: databaseUrl,
        APP_RUNTIME_PASSWORD: "",
      }),
      60_000,
    );
    const jsonStart = result.stdout.indexOf("{");
    const jsonEnd = result.stdout.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) {
      throw new Error(`vitest did not return a JSON report\n${result.stderr}`);
    }
    const parsed = JSON.parse(result.stdout.slice(jsonStart, jsonEnd + 1)) as {
      numPassedTests: number;
      numFailedTests: number;
      testResults: Array<{
        name: string;
        assertionResults: Array<{ status: string; fullName: string }>;
      }>;
    };
    expect(result.code).toBe(0);
    expect(parsed.numPassedTests).toBe(0);
    expect(parsed.numFailedTests).toBe(0);
    const files = parsed.testResults.map((file) => file.name.replaceAll("\\", "/"));
    expect(files).toEqual([expect.stringContaining(suite)]);
    const results = parsed.testResults.flatMap((file) => file.assertionResults);
    expect(results.map((item) => item.status)).toEqual([
      "skipped",
      "skipped",
      "skipped",
      "skipped",
      "skipped",
      "skipped",
      "skipped",
    ]);
    expect(results.map((item) => item.fullName)).toEqual([
      "catalog photo audit reader reader returns every seeded master product, including inactive and rejected (AC5)",
      "catalog photo audit reader real reader returns more than 1000 fixture rows across all statuses (E34)",
      "catalog photo audit reader actual reader dependency denies writes to known existing fixture rows (AC5, E5)",
      "catalog photo audit reader named setup rolls back after a partial insert failure",
      "catalog photo audit reader cleanup removes attempted denied-write IDs after failure and is idempotent",
      "catalog photo audit reader a second run on the same database removes only its own rows",
      "catalog photo audit reader cleanup preserves another live run and unrelated rows",
    ]);
  }, 60_000);
});
