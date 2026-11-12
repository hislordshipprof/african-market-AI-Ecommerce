import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { effectivePgTarget, isLoopbackHost, refuseLiveEval } from "./preflight";

const SECRET = "x".repeat(32);
const LOCAL = "postgresql://owner:owner-secret@127.0.0.1:5434/lane_t146";

function allowedEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    ASSISTANT_EVAL_LIVE: "1",
    ANTHROPIC_API_KEY: "sk-ant-live-test",
    APP_RUNTIME_PASSWORD: "runtime-secret",
    BETTER_AUTH_SECRET: SECRET,
    DATABASE_URL: LOCAL,
    ...overrides,
  };
}

describe("shopper assistant eval preflight", () => {
  it("the live eval refuses to start without the opt-in, with a fake or missing key, on Vercel, or against a non-local database, and creates nothing", () => {
    expect(refuseLiveEval(allowedEnv({ ASSISTANT_EVAL_LIVE: undefined }))).toMatch(/ASSISTANT_EVAL_LIVE=1/);
    expect(refuseLiveEval(allowedEnv({ ANTHROPIC_API_KEY: "" }))).toMatch(/missing or blank/);
    expect(refuseLiveEval(allowedEnv({ ANTHROPIC_API_KEY: undefined }))).toMatch(/missing or blank/);
    expect(refuseLiveEval(allowedEnv({ ANTHROPIC_API_KEY: "e2e-fake-anthropic-key" }))).toMatch(/fake Anthropic key/);
    expect(refuseLiveEval(allowedEnv({
      E2E_FAKE_ASSISTANT: "1",
      CI: "true",
      ANTHROPIC_API_KEY: "sk-ant-live-test",
    }))).toMatch(/active fake/);
    expect(refuseLiveEval(allowedEnv({ VERCEL: "1" }))).toMatch(/Vercel/);
    expect(refuseLiveEval(allowedEnv({
      DATABASE_URL: "postgresql://owner:secret@ep-cool-night.neon.tech/neondb",
    }))).toMatch(/local app_runtime/);
    expect(refuseLiveEval(allowedEnv({ ASSISTANT_MODEL: "claude-not-a-model" }))).toMatch(/invalid/);
    expect(refuseLiveEval(allowedEnv({ ASSISTANT_MODEL: "claude-sonnet-5-5" }))).toMatch(/claude-haiku-5-5/);
    expect(refuseLiveEval(allowedEnv({ APP_RUNTIME_PASSWORD: undefined }))).toMatch(/APP_RUNTIME_PASSWORD/);
  });

  it("refuses unsafe effective connections and missing production configuration before opening clients", async () => {
    const overridden = "postgresql://eval:dummy@localhost/eval?host=example.invalid&user=app_owner&password=dummy";
    const effective = effectivePgTarget(overridden);
    expect(effective.host).toBe("example.invalid");
    expect(effective.user).toBe("app_owner");
    expect(isLoopbackHost(effective.host)).toBe(false);
    expect(refuseLiveEval(allowedEnv({ DATABASE_URL: overridden }))).toMatch(/local app_runtime/);

    const ipv6 = "postgresql://owner:secret@[::1]:5434/lane_t146";
    expect(effectivePgTarget(ipv6).host).toBe("::1");
    expect(refuseLiveEval(allowedEnv({ DATABASE_URL: ipv6 }))).toBeNull();

    const queryUser = "postgresql://app_runtime:secret@127.0.0.1:5434/lane_t146?user=app_owner";
    expect(refuseLiveEval(allowedEnv({ DATABASE_URL: queryUser }))).toMatch(/local app_runtime/);

    expect(refuseLiveEval(allowedEnv({ BETTER_AUTH_SECRET: "short" }))).toMatch(/BETTER_AUTH_SECRET/);
    expect(refuseLiveEval(allowedEnv({ BETTER_AUTH_SECRET: undefined }))).toMatch(/BETTER_AUTH_SECRET/);
    expect(refuseLiveEval(allowedEnv({ ASSISTANT_EVAL_MAX_USD: "0" }))).toMatch(/ASSISTANT_EVAL_MAX_USD/);
    expect(refuseLiveEval(allowedEnv({ ASSISTANT_EVAL_MAX_USD: "nope" }))).toMatch(/ASSISTANT_EVAL_MAX_USD/);
    expect(refuseLiveEval(allowedEnv({ ASSISTANT_EVAL_CONCURRENCY: "5" }))).toMatch(/ASSISTANT_EVAL_CONCURRENCY/);
    expect(refuseLiveEval(allowedEnv())).toBeNull();

    const child = await runLiveSetup({
      NODE_ENV: "production",
      ASSISTANT_EVAL_LIVE: "1",
      ANTHROPIC_API_KEY: "sk-ant-live-test",
      APP_RUNTIME_PASSWORD: "runtime-secret",
      BETTER_AUTH_SECRET: "short",
      DATABASE_URL: "postgresql://eval:dummy@localhost/eval?host=example.invalid&user=app_owner&password=dummy",
      VERCEL: "",
      E2E_FAKE_ASSISTANT: "",
      CI: "",
    });
    expect(child.code).not.toBe(0);
    expect(child.stderr).toMatch(/BETTER_AUTH_SECRET|local app_runtime/);
    expect(child.stderr).not.toMatch(/dummy|owner-secret|runtime-secret/);
    expect(child.ms).toBeLessThan(20_000);
  }, 45_000);
});

function runLiveSetup(overrides: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string; ms: number }> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === "") delete env[key];
  }
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      ["exec", "vitest", "run", "--config", "vitest.eval.config.ts", "--maxWorkers", "1"],
      { cwd: process.cwd(), env, shell: true },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`live setup hung:\n${stderr}`));
    }, 25_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, ms: Date.now() - started });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
