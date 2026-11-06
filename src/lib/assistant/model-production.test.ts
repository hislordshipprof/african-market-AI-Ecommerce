import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const tsx = path.resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const probe = path.resolve(__dirname, "model-production-probe.ts");

function runProbe(phase: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [tsx, probe, phase], {
    cwd: path.resolve(__dirname, "../../.."),
    env,
    encoding: "utf8",
  });
  return result;
}

function baseEnv(extra: {
  ANTHROPIC_BASE_URL?: string;
  ASSISTANT_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    PATHEXT: process.env.PATHEXT,
    NODE_ENV: "production",
    VERCEL: "1",
    CI: "1",
    AI_GATEWAY_API_KEY: "gateway-secret",
    VERCEL_OIDC_TOKEN: "oidc-secret",
    ...extra,
  };
}

describe("assistant model production import", () => {
  it("cold import ignores empty and whitespace ANTHROPIC_BASE_URL", () => {
    for (const baseUrl of ["", "   "]) {
      const result = runProbe(
        "missing-key",
        baseEnv({ ANTHROPIC_BASE_URL: baseUrl }),
      );
      expect(result.status, result.stderr).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        importOk: boolean;
        failedClosed: boolean;
        laterText: string;
        fetchCalls: number;
      };
      expect(parsed.importOk).toBe(true);
      expect(parsed.failedClosed).toBe(true);
      expect(parsed.laterText).toBe("ok");
      expect(parsed.fetchCalls).toBe(1);
    }
  });

  it("production import is inert and configuration fails only on invocation", () => {
    const missing = runProbe("missing-key", baseEnv({}));
    expect(missing.status, missing.stderr).toBe(0);
    const missingParsed = JSON.parse(missing.stdout) as { errorName: string; fetchCalls: number };
    expect(missingParsed.errorName).toBe("AssistantConfigError");
    expect(missingParsed.fetchCalls).toBe(1);

    const invalid = runProbe(
      "invalid-model",
      baseEnv({ ASSISTANT_MODEL: "gpt-4o", ANTHROPIC_API_KEY: "sk-ant-probe-key" }),
    );
    expect(invalid.status, invalid.stderr).toBe(0);
    const invalidParsed = JSON.parse(invalid.stdout) as { errorName: string };
    expect(invalidParsed.errorName).toBe("AssistantConfigError");
  });

  it("reads a real PDF and JPEG with the installed parsers", () => {
    const result = runProbe("read-pdf", baseEnv({}));
    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as { pages: number; format: string; external: boolean };
    expect(parsed.pages).toBe(2);
    expect(parsed.format).toBe("jpeg");
    expect(parsed.external).toBe(true);
  });

  it("the live photo and PDF check does not run unless it is opted in", () => {
    const result = spawnSync(process.execPath, ["scripts/assistant-live-check.mjs"], {
      cwd: path.resolve(__dirname, "../../.."),
      env: { ...process.env, ASSISTANT_LIVE_TESTS: "0" },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ skipped: true });
  });
});
