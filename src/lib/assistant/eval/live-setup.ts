/**
 * Vitest setup for the live eval only. Loads env, then refuses before any
 * database, auth, or fixture import. The default test setup is not used.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { refuseLiveEval } from "./preflight";

const envLocalPath = resolve(process.cwd(), ".env.local");
if (existsSync(envLocalPath)) {
  for (const line of readFileSync(envLocalPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
}

const reason = refuseLiveEval(process.env);
if (reason) {
  console.error(reason);
  process.exit(1);
}
