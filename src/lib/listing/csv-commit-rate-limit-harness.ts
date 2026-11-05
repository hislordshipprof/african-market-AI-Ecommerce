import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { authPrisma } from "../db";
import { isSingleIpv4 } from "./csv-commit-prod-guard";

/**
 * Better Auth stores rate limits in the shared `rate_limits` table and enables
 * that storage only when NODE_ENV is production. Vitest still sets TEST=true,
 * so a handler request with no trusted address falls back to 127.0.0.1 (or
 * one shared no-trusted-ip bucket outside test/dev). The built-in /sign-up and
 * /two-factor/enable windows are 3 requests per 10 seconds; this app's custom
 * rules do not widen those paths. Each production child therefore sends its
 * own 10.0.0.0/8 IPv4 in x-forwarded-for. IPv6 is masked to /64 and would
 * collide, including with e2e.
 *
 * Cleanup deletes only rows whose key starts with "<identity>|". A blanket
 * delete races invite, assistant, and storage-suite writers in the same table.
 * Better Auth's own window reset also deletes rows whose last_request is older
 * than the longest configured window (60 seconds). That sweep stays enabled.
 * The harness does not promise other namespaces are immune to it; sentinels
 * this suite still needs are stamped in the future, and identity evidence is
 * recorded at the auth boundary before a later reset can prune it.
 */

export const AUTH_IP_ENV = "CSV_COMMIT_AUTH_IP";
export const IDENTITY_EVIDENCE_PREFIX = "CSV_COMMIT_IDENTITY_EVIDENCE ";
export const WINDOW_RESET_PREFIX = "CSV_COMMIT_WINDOW_RESET ";
export const AUTH_PATHS = [
  "/sign-up/email",
  "/sign-in/email",
  "/two-factor/enable",
  "/two-factor/verify-totp",
] as const;

export type AuthPath = (typeof AUTH_PATHS)[number];

export interface IdentityPathEvidence {
  key: string;
  count: number;
  lastRequest: string;
}

export interface IdentityEvidence {
  ip: string;
  evidence: Record<string, IdentityPathEvidence | null>;
}

export interface SpawnResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
  output: string;
  timedOut: boolean;
}

export class ChildRunError extends Error {
  readonly result: SpawnResult;

  constructor(message: string, result: SpawnResult) {
    super(message);
    this.name = "ChildRunError";
    this.result = result;
  }
}

export { isSingleIpv4 } from "./csv-commit-prod-guard";

export function freshRateLimitIpv4(): string {
  const octet = () => Math.floor(Math.random() * 256);
  return `10.${octet()}.${octet()}.${octet()}`;
}

export function futureRequestStamp(): bigint {
  return BigInt(Date.now() + 15 * 60 * 1000);
}

export function scrubSecrets(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://redacted");
}

export function formatChildFailure(result: SpawnResult): string {
  return [
    "production child failed",
    `status=${result.status ?? "null"}`,
    `signal=${result.signal ?? "null"}`,
    `timedOut=${String(result.timedOut)}`,
    `error=${result.error ?? "null"}`,
    result.output.slice(-2000),
  ].join("\n");
}

export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process already exited.
    }
  }
}

export function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: options.cwd ?? process.cwd(),
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolve({ status: null, signal: null, error: message, output: "", timedOut: false });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (result: SpawnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, output: scrubSecrets(result.output) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killProcessTree(child.pid);
    }, options.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({
        status: null,
        signal: null,
        error: error.message,
        output: `${stdout}\n${stderr}`,
        timedOut,
      });
    });
    child.on("close", (code, signal) => {
      finish({
        status: code,
        signal,
        error: timedOut ? `timed out after ${options.timeoutMs}ms` : null,
        output: `${stdout}\n${stderr}`,
        timedOut,
      });
    });
  });
}

/**
 * One child invocation, then identity-scoped cleanup.
 * Spawn, observation, and the status check all sit inside the try; cleanup
 * always runs afterwards. A cleanup error keeps the child diagnostic.
 */
export async function runProductionAttempt(options: {
  identity: string;
  spawn: () => Promise<SpawnResult>;
  observe?: (result: SpawnResult) => Promise<void>;
  cleanup?: (identity: string) => Promise<void>;
}): Promise<SpawnResult> {
  const cleanup = options.cleanup ?? (async (identity: string) => {
    await deleteRateLimitsForIdentity(identity);
  });
  let result: SpawnResult | undefined;
  let failure: unknown;
  try {
    try {
      result = await options.spawn();
      if (options.observe) {
        try {
          await options.observe(result);
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          throw new Error(`${text}\n${formatChildFailure(result)}`);
        }
      }
      if (result.error || result.signal || result.timedOut || result.status !== 0) {
        throw new ChildRunError(formatChildFailure(result), result);
      }
    } catch (error) {
      failure = error;
    }
  } finally {
    try {
      await cleanup(options.identity);
    } catch (cleanupError) {
      const cleanupText = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      const childText = failure instanceof Error ? failure.message : failure ? String(failure) : "";
      failure = new Error(
        childText ? `child failed: ${childText}\ncleanup failed: ${cleanupText}` : `cleanup failed: ${cleanupText}`,
      );
    }
  }
  if (failure) throw failure;
  if (!result) throw new Error("production child produced no result");
  return result;
}

async function deleteIdentityPrefix(identity: string): Promise<number> {
  const deleted = await authPrisma.rateLimit.deleteMany({
    where: { key: { startsWith: `${identity}|` } },
  });
  return deleted.count;
}

let identityDeleter = deleteIdentityPrefix;

/** Test seam: a double records whether cleanup reached storage. Pass null to restore. */
export function replaceIdentityDeleterForTests(next: ((identity: string) => Promise<number>) | null): void {
  identityDeleter = next ?? deleteIdentityPrefix;
}

export async function deleteRateLimitsForIdentity(identity: string): Promise<number> {
  if (!isSingleIpv4(identity)) {
    throw new Error("csv commit error suite requires CSV_COMMIT_AUTH_IP");
  }
  return identityDeleter(identity);
}

export async function logAuthIdentityEvidence(ip: string): Promise<void> {
  const keys = AUTH_PATHS.map((authPath) => `${ip}|${authPath}`);
  const rows = await authPrisma.rateLimit.findMany({ where: { key: { in: keys } } });
  const evidence: Record<string, IdentityPathEvidence | null> = {};
  for (const authPath of AUTH_PATHS) {
    const key = `${ip}|${authPath}`;
    const row = rows.find((item) => item.key === key);
    evidence[authPath] = row
      ? { key, count: row.count, lastRequest: row.lastRequest.toString() }
      : null;
  }
  process.stdout.write(`${IDENTITY_EVIDENCE_PREFIX}${JSON.stringify({ ip, evidence })}\n`);
  const missing = AUTH_PATHS.filter((authPath) => evidence[authPath] === null);
  if (missing.length > 0) {
    throw new Error(`csv commit auth identity missing rows for ${missing.join(", ")}`);
  }
}

export function readIdentityEvidence(output: string): IdentityEvidence {
  const line = output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .reverse()
    .find((item) => item.includes(IDENTITY_EVIDENCE_PREFIX));
  if (!line) throw new Error("missing CSV_COMMIT_IDENTITY_EVIDENCE");
  const json = line.slice(line.indexOf(IDENTITY_EVIDENCE_PREFIX) + IDENTITY_EVIDENCE_PREFIX.length);
  return JSON.parse(json) as IdentityEvidence;
}

export function findUnscopedRateLimitDeletes(source: string): string[] {
  const hits: string[] = [];
  const callRe = /\brateLimit\.deleteMany\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(source))) {
    const open = match.index + match[0].length - 1;
    const close = findBalancedParen(source, open);
    const args = close < 0 ? source.slice(open + 1) : source.slice(open + 1, close);
    if (!/\bkey\s*:/.test(args)) {
      const end = close < 0 ? Math.min(source.length, open + 120) : close + 1;
      hits.push(source.slice(match.index, end).replace(/\s+/g, " "));
    }
    if (close >= 0) callRe.lastIndex = close + 1;
  }
  const sqlRe = /DELETE\s+FROM\s+"?rate_limits"?/gi;
  while ((match = sqlRe.exec(source))) {
    const semicolon = source.indexOf(";", match.index);
    const tail = source.slice(match.index, semicolon === -1 ? source.length : semicolon);
    if (!/\bWHERE\b/i.test(tail)) hits.push(tail.replace(/\s+/g, " ").slice(0, 180));
  }
  return hits;
}

function findBalancedParen(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function stripCommentsAndStrings(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (char === "/" && next === "/") {
      out += "  ";
      i += 2;
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < source.length) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      const quote = char;
      out += " ";
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          out += " ";
          i += 1;
          break;
        }
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

export function rateLimitSourceFiles(root = path.join(process.cwd(), "src")): string[] {
  const found: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules") continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (entry.endsWith(".test.ts")) found.push(full);
    }
  };
  visit(root);
  found.push(path.join(root, "lib", "listing", "csv-commit-rate-limit-harness.ts"));
  return found;
}

export function unscopedRateLimitDeletesInSources(files: string[]): Array<{ file: string; hits: string[] }> {
  const violations: Array<{ file: string; hits: string[] }> = [];
  for (const file of files) {
    const hits = findUnscopedRateLimitDeletes(stripCommentsAndStrings(readFileSync(file, "utf8")));
    if (hits.length > 0) violations.push({ file, hits });
  }
  return violations;
}
