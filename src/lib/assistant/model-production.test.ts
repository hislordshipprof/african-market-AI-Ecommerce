import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

const KEY = "sk-ant-fixture-cold";
const HAIKU = "claude-haiku-5-5";
const root = path.resolve(__dirname, "../../..");
const moduleUrl = pathToFileURL(path.join(root, "src/lib/assistant/model.ts")).href;

afterEach(() => {
  vi.unstubAllEnvs();
});

it("cold import ignores empty and whitespace ANTHROPIC_BASE_URL", () => {
  for (const baseURL of ["", "   "]) {
    vi.stubEnv("ASSISTANT_MODEL", undefined);
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("ANTHROPIC_BASE_URL", undefined);
    const report = runProbe("request", {
      ASSISTANT_MODEL: HAIKU,
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_BASE_URL: baseURL,
      VERCEL: "1",
      CI: "1",
      VERCEL_OIDC_TOKEN: "oidc-fixture",
      AI_GATEWAY_API_KEY: "gateway-fixture",
    });
    expect(report.imported).toBe(true);
    expect(report.fetchesDuringImport).toBe(0);
    expect(report.steps).toHaveLength(1);
    const step = report.steps[0]!;
    expect(step.kind).toBe("request");
    if (step.kind !== "request") continue;
    expect(step.url).toBe("https://api.anthropic.com/v1/messages");
    expect(step.method).toBe("POST");
    expect(step.bodyModel).toBe(HAIKU);
    expect(step.modelId).toBe(HAIKU);
    expect(step.provider).toBe("anthropic.messages");
    expect(step.hasAuthorization).toBe(false);
    expect(step.keyDigest).toBe(digest(KEY));
    expect(step.thinking).toEqual({ type: "disabled" });
    expect(step.effort).toBe("medium");
    expect(step.sampling).toEqual([]);
    expect(step.warningCount).toBe(0);
    expect(step.text).toBe("ok");
    expect(step.fetchCount).toBe(1);
    expect(step.messageIncludesGateway).toBe(false);
  }
});

it("production import is inert and configuration fails only on invocation", () => {
  vi.stubEnv("ASSISTANT_MODEL", undefined);
  vi.stubEnv("ANTHROPIC_API_KEY", undefined);
  vi.stubEnv("ANTHROPIC_BASE_URL", undefined);
  const report = runProbe("invalid-then-valid", {
    ASSISTANT_MODEL: "gpt-4o",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_BASE_URL: "",
    VERCEL: "1",
    CI: "1",
    VERCEL_OIDC_TOKEN: "oidc-fixture",
    AI_GATEWAY_API_KEY: "gateway-fixture",
  });
  expect(report.imported).toBe(true);
  expect(report.fetchesDuringImport).toBe(0);
  expect(report.steps.map((step) => step.kind)).toEqual(["error", "error", "request"]);
  const modelError = report.steps[0];
  const keyError = report.steps[1];
  const request = report.steps[2];
  if (modelError?.kind !== "error" || keyError?.kind !== "error" || request?.kind !== "request") {
    throw new Error("probe steps did not match the cold-start sequence");
  }
  expect(modelError.name).toBe("AssistantConfigError");
  expect(modelError.message).toContain("ASSISTANT_MODEL");
  expect(modelError.message.includes("gpt-4o")).toBe(false);
  expect(modelError.fetchCount).toBe(0);
  expect(keyError.name).toBe("AssistantConfigError");
  expect(keyError.message).toContain("ANTHROPIC_API_KEY");
  expect(keyError.message.includes("oidc-fixture")).toBe(false);
  expect(keyError.message.includes("gateway-fixture")).toBe(false);
  expect(keyError.fetchCount).toBe(0);
  expect(request.url).toBe("https://api.anthropic.com/v1/messages");
  expect(request.bodyModel).toBe(HAIKU);
  expect(request.provider).toBe("anthropic.messages");
  expect(request.hasAuthorization).toBe(false);
  expect(request.keyDigest).toBe(digest(KEY));
  expect(request.fetchCount).toBe(1);
  expect(request.text).toBe("ok");
});

type ProbeStep =
  | { kind: "error"; name: string; message: string; fetchCount: number }
  | {
      kind: "request";
      url: string;
      method: string;
      bodyModel: string;
      modelId: string;
      provider: string;
      hasAuthorization: boolean;
      keyDigest: string;
      thinking: unknown;
      effort: unknown;
      sampling: string[];
      warningCount: number;
      text: string;
      fetchCount: number;
      messageIncludesGateway: boolean;
    };

type ProbeReport = {
  imported: boolean;
  fetchesDuringImport: number;
  errorName: string | null;
  errorMessage: string | null;
  steps: ProbeStep[];
};

function runProbe(scenario: string, envOverrides: Record<string, string>): ProbeReport {
  const probePath = path.join(root, `.assistant-probe-${process.pid}.mjs`);
  writeFileSync(probePath, PROBE_SOURCE, "utf8");
  try {
    const result = spawnSync(
      process.execPath,
      ["--conditions=react-server", "--import", "tsx", probePath, moduleUrl, scenario, KEY],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
        env: childEnv(envOverrides),
      },
    );
    const output = redact(result.stdout);
    const errors = redact(result.stderr);
    let report: ProbeReport | undefined;
    const line = output.trim().split(/\r?\n/).find((entry) => entry.startsWith("{"));
    if (line) {
      report = JSON.parse(line) as ProbeReport;
    }
    expect(result.status, errors || output).toBe(0);
    if (!report) throw new Error(errors || output || "probe produced no report");
    return report;
  } finally {
    try {
      unlinkSync(probePath);
    } catch {
      // The probe is scratch state. A missing file means it was already removed.
    }
  }
}

function childEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    Path: process.env.Path,
    PATHEXT: process.env.PATHEXT,
    SYSTEMROOT: process.env.SYSTEMROOT,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    NODE_ENV: "production",
  };
  for (const [name, value] of Object.entries(overrides)) env[name] = value;
  return env;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function redact(value: string): string {
  return value.split(KEY).join("[redacted]");
}

const PROBE_SOURCE = `
import { createHash } from "node:crypto";
import { generateText } from "ai";

const moduleUrl = process.argv[2];
const scenario = process.argv[3];
const key = process.argv[4];
const calls = [];

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function record(input, init) {
  const request = input instanceof Request ? input : null;
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const headers = new Headers(request?.headers);
  if (init?.headers) new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  const raw = typeof init?.body === "string" ? init.body : "";
  const body = raw ? JSON.parse(raw) : {};
  const presented = headers.get("x-api-key") ?? "";
  calls.push({
    url,
    method,
    bodyModel: body.model ?? null,
    hasAuthorization: headers.has("authorization"),
    keyDigest: digest(presented),
    thinking: body.thinking ?? null,
    effort: body.output_config?.effort ?? null,
    sampling: ["temperature", "top_p", "top_k"].filter((name) => name in body),
    messageIncludesGateway: JSON.stringify(body).includes("ai-gateway") || url.includes("ai-gateway"),
  });
  return new Response(JSON.stringify({
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model: body.model ?? "",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 3 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

globalThis.fetch = (input, init) => record(input, init);

const report = { imported: false, fetchesDuringImport: 0, errorName: null, errorMessage: null, steps: [] };
try {
  const mod = await import(moduleUrl);
  report.imported = true;
  report.fetchesDuringImport = calls.length;
  if (scenario === "request") {
    const model = mod.createAssistantModel();
    const result = await generateText({
      model,
      prompt: "ping",
      providerOptions: mod.assistantProviderOptions(model.modelId),
    });
    const call = calls[calls.length - 1];
    report.steps.push({ kind: "request", ...call, modelId: model.modelId, provider: model.provider, warningCount: result.warnings.length, text: result.text, fetchCount: calls.length });
  } else if (scenario === "invalid-then-valid") {
    try {
      mod.assistantModelId();
      report.steps.push({ kind: "error", name: "none", message: "model id was accepted", fetchCount: calls.length });
    } catch (error) {
      report.steps.push({ kind: "error", name: error.name, message: String(error.message).slice(0, 240), fetchCount: calls.length });
    }
    process.env.ASSISTANT_MODEL = "claude-haiku-5-5";
    try {
      mod.createAssistantModel();
      report.steps.push({ kind: "error", name: "none", message: "missing key was accepted", fetchCount: calls.length });
    } catch (error) {
      report.steps.push({ kind: "error", name: error.name, message: String(error.message).slice(0, 240), fetchCount: calls.length });
    }
    process.env.ANTHROPIC_API_KEY = key;
    const model = mod.createAssistantModel();
    const result = await generateText({
      model,
      prompt: "ping",
      providerOptions: mod.assistantProviderOptions(model.modelId),
    });
    const call = calls[calls.length - 1];
    report.steps.push({ kind: "request", ...call, modelId: model.modelId, provider: model.provider, warningCount: result.warnings.length, text: result.text, fetchCount: calls.length });
  } else {
    throw new Error("unknown scenario");
  }
} catch (error) {
  report.errorName = error.name;
  report.errorMessage = String(error.message).slice(0, 240);
  console.log(JSON.stringify(report));
  process.exit(1);
}
console.log(JSON.stringify(report));
`;
