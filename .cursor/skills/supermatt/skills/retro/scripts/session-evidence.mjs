#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const HOSTS = new Set(["claude", "codex", "cursor", "omp"]);

function fail(message) {
  throw new Error(message);
}

function inside(root, path) {
  const rel = relative(realpathSync(root), realpathSync(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function text(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!item || typeof item !== "object") return [];
    if (["text", "input_text", "output_text"].includes(item.type) && typeof item.text === "string") return [item.text];
    if (typeof item.content === "string") return [item.content];
    return [];
  }).filter(Boolean).join("\n");
}

function jsonl(path) {
  return readFileSync(path, "utf8").split(/\r?\n/).flatMap((source, index) => {
    if (!source.trim()) return [];
    try {
      return [{ line: index + 1, value: JSON.parse(source) }];
    } catch {
      fail(`malformed JSONL at ${path}:${index + 1}`);
    }
  });
}

function files(path, accept, depth = 3) {
  if (!existsSync(path) || depth < 0) return [];
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return files(child, accept, depth - 1);
    return accept(child) ? [child] : [];
  });
}

function cursorRecords(path, main = false) {
  const entries = jsonl(path);
  const records = [];
  for (const { line, value } of entries) {
    const role = value?.role;
    const content = value?.message?.content;
    if (!Array.isArray(content) || !["user", "assistant", "tool"].includes(role)) continue;
    const spoken = text(content.filter((item) => item?.type !== "tool_result"));
    if (spoken && role !== "tool") records.push({ line, kind: role, text: spoken });
    for (const item of content) {
      if (item?.type !== "tool_result" || !(item.is_error || item.isError)) continue;
      const error = text(item.content);
      if (error) records.push({ line, kind: "tool-error", text: error });
    }
  }
  if (!records.length || (main && !records.some(({ kind }) => kind === "user"))) {
    fail(`unsupported Cursor transcript layout at ${path}`);
  }
  return records;
}

function cursorSession(path) {
  const directory = dirname(path);
  const sessions = [{ path, records: cursorRecords(path, true) }];
  for (const child of files(join(directory, "subagents"), (file) => extname(file) === ".jsonl")) {
    sessions.push({ path: child, records: cursorRecords(child) });
  }
  for (const summary of files(join(directory, "compaction"), () => true)) {
    const value = readFileSync(summary, "utf8").trim();
    if (value) sessions.push({ path: summary, records: [{ line: 1, kind: "summary", text: value }] });
  }
  return sessions;
}

function activeEntries(entries) {
  const indexed = new Map(entries.filter(({ value }) => value?.id).map((entry) => [entry.value.id, entry]));
  const last = entries.findLast(({ value }) => value?.id && value.type !== "session");
  let leafId = last?.value.type === "model_usage" && last.value.activeLeafId !== undefined
    ? last.value.activeLeafId
    : last?.value.id;
  if (typeof leafId === "string" && !indexed.has(leafId)) {
    leafId = entries.findLast(({ value }) => value?.id && value.type !== "session"
      && (value.type !== "model_usage" || value.activeLeafId === undefined || value.activeLeafId === value.id))?.value.id;
  }
  let current = typeof leafId === "string" ? indexed.get(leafId) : undefined;
  const active = new Set();
  while (current && !active.has(current.value.id)) {
    active.add(current.value.id);
    current = current.value.parentId == null ? undefined : indexed.get(current.value.parentId);
  }
  return entries.filter(({ value }) => !value?.id || active.has(value.id));
}

function ompRecords(path, main = false, cwd) {
  const entries = jsonl(path);
  const header = entries.find(({ value }) => value?.type === "session")?.value;
  if (!header || resolve(header.cwd) !== cwd) fail(`unsupported or mismatched OMP transcript at ${path}`);
  const records = [];
  for (const { line, value } of activeEntries(entries)) {
    if (["compaction", "branch_summary", "summary"].includes(value?.type)) {
      if (typeof value.summary === "string" && value.summary) records.push({ line, kind: "summary", text: value.summary });
      continue;
    }
    if (value?.type !== "message") continue;
    const role = value.message?.role;
    const spoken = text(value.message?.content);
    if (!spoken) continue;
    if (["user", "developer"].includes(role)) records.push({ line, kind: "user", text: spoken });
    else if (role === "assistant") records.push({ line, kind: "assistant", text: spoken });
    else if (role === "toolResult" && (value.message?.isError || value.message?.is_error || value.message?.details?.isError)) records.push({ line, kind: "tool-error", text: spoken });
  }
  if (!records.length || (main && !records.some(({ kind }) => kind === "user"))) fail(`unsupported OMP transcript schema at ${path}`);
  return records;
}

function ompSession(path, cwd) {
  const sessions = [{ path, records: ompRecords(path, true, cwd) }];
  const children = path.slice(0, -extname(path).length);
  for (const child of files(children, (file) => extname(file) === ".jsonl" && !basename(file).startsWith("."))) {
    sessions.push({ path: child, records: ompRecords(child, false, cwd) });
  }
  return sessions;
}

function failedOutput(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const failure = failedOutput(item);
      if (failure) return failure;
    }
    return "";
  }
  if (!value || typeof value !== "object") return "";
  if ((Number.isInteger(value.exit_code) && value.exit_code !== 0) || ["error", "failed", "rejected"].includes(value.status)) {
    return typeof value.output === "string" && value.output ? value.output : JSON.stringify(value);
  }
  for (const item of Object.values(value)) {
    const failure = failedOutput(item);
    if (failure) return failure;
  }
  return "";
}

function codexToolError(item) {
  if (item?.type === "item_completed" && item.item?.type === "CommandExecution"
    && (item.item.exit_code !== 0 || ["error", "failed", "rejected"].includes(item.item.status))) {
    return item.item.aggregated_output || JSON.stringify(item.item);
  }
  if (!["custom_tool_call_output", "function_call_output"].includes(item?.type)) return "";
  const output = text(item.output);
  if (item.is_error || item.isError || ["error", "failed", "rejected"].includes(item.status)) return output;
  const blocks = Array.isArray(item.output) ? item.output : [{ text: output }];
  for (const block of blocks) {
    if (typeof block?.text !== "string") continue;
    try {
      const failure = failedOutput(JSON.parse(block.text));
      if (failure) return failure;
    } catch {
      // Non-JSON tool output has no machine-readable failure status.
    }
  }
  return "";
}

function genericRecords(path, host, main, cwd) {
  const records = [];
  const entries = jsonl(path);
  const workspaces = host === "claude"
    ? entries.flatMap(({ value }) => typeof value?.cwd === "string" ? [value.cwd] : [])
    : entries.flatMap(({ value }) => value?.type === "session_meta" && typeof value.payload?.cwd === "string" ? [value.payload.cwd] : []);
  if (!workspaces.length || workspaces.some((workspace) => resolve(workspace) !== cwd)) {
    fail(`unsupported or mismatched ${host} transcript at ${path}`);
  }
  for (const { line, value } of entries) {
    const item = value?.payload && typeof value.payload === "object" ? value.payload : value;
    const message = item?.message && typeof item.message === "object" ? item.message : item;
    const failure = host === "codex" ? codexToolError(item) : "";
    if (failure) records.push({ line, kind: "tool-error", text: failure });
    const role = message?.role;
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const result of content.filter(({ type, is_error, isError } = {}) => type === "tool_result" && (is_error || isError))) {
        const output = text([result]);
        if (output) records.push({ line, kind: "tool-error", text: output });
      }
    }
    const spoken = text(Array.isArray(content) ? content.filter(({ type } = {}) => type !== "tool_result") : content)
      || (typeof item?.message === "string" ? item.message : "");
    if (spoken && ["user", "developer"].includes(role)) records.push({ line, kind: "user", text: spoken });
    else if (spoken && role === "assistant") records.push({ line, kind: "assistant", text: spoken });
    else if (spoken && role === "tool" && (message?.is_error || message?.isError)) records.push({ line, kind: "tool-error", text: spoken });
    else if (typeof item?.summary === "string" && /summary|compact/.test(item.type ?? value.type ?? "")) records.push({ line, kind: "summary", text: item.summary });
  }
  if (!records.length || (main && !records.some(({ kind }) => kind === "user"))) fail(`unsupported ${host} transcript schema at ${path}`);
  return records;
}

function rootList(host, cwd) {
  const home = process.env.HOME || homedir();
  if (host === "cursor") {
    const documented = cwd.slice(1).replaceAll("/", "-");
    const observed = documented.replace(/[^A-Za-z0-9_-]/g, "-");
    return [...new Set([documented, observed].map((slug) => join(home, ".cursor", "projects", slug, "agent-transcripts")))];
  }
  if (host === "omp") {
    const configured = [process.env.PI_CODING_AGENT_SESSION_DIR, process.env.OMP_SESSION_DIR, process.env.OMP_SESSION_ROOT, process.env.PI_SESSION_DIR].filter(Boolean);
    if (process.env.PI_CODING_AGENT_DIR) configured.push(join(process.env.PI_CODING_AGENT_DIR, "sessions"));
    configured.push(join(home, ".omp", "agent", "sessions"));
    const profile = process.env.OMP_PROFILE !== undefined ? process.env.OMP_PROFILE : process.env.PI_PROFILE;
    if (process.env.XDG_DATA_HOME) {
      const dataRoot = profile && profile !== "default"
        ? join(process.env.XDG_DATA_HOME, "omp", "profiles", profile)
        : join(process.env.XDG_DATA_HOME, "omp");
      configured.push(join(dataRoot, "sessions"));
    }
    if (profile) {
      if (isAbsolute(profile)) configured.push(join(profile, "sessions"));
      else configured.push(join(home, ".omp", "profiles", profile, "agent", "sessions"));
    }
    return [...new Set(configured.map((path) => resolve(path)))];
  }
  if (host === "claude") return [join(process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects")];
  return [join(process.env.CODEX_HOME || join(home, ".codex"), "sessions")];
}

function requestedFile(host, request, roots, cwd) {
  if (isAbsolute(request)) {
    const candidate = existsSync(request) && statSync(request).isDirectory()
      ? join(request, `${basename(request)}.jsonl`)
      : request;
    if (!existsSync(candidate)) fail(`cannot identify requested ${host} session: ${request}`);
    const root = roots.find((item) => existsSync(item) && inside(item, candidate));
    if (!root) fail(`path is outside the verified ${host === "cursor" ? "Cursor workspace" : host.toUpperCase()} root: ${request}`);
    return realpathSync(candidate);
  }
  if (host === "cursor") {
    const matches = roots.map((root) => join(root, request, `${request}.jsonl`)).filter(existsSync);
    if (matches.length !== 1) fail(`cannot identify requested Cursor session: ${request}`);
    return realpathSync(matches[0]);
  }
  const matches = roots.flatMap((root) => files(root, (path) => extname(path) === ".jsonl" && basename(path).includes(request), 3));
  const exact = matches.filter((path) => host !== "omp" || jsonl(path).some(({ value }) => value?.type === "session" && resolve(value.cwd) === cwd));
  if (exact.length !== 1) fail(`cannot identify requested ${host} session: ${request}`);
  return realpathSync(exact[0]);
}

function evidence(host, cwd, requests) {
  const roots = rootList(host, cwd);
  const metadata = host === "cursor"
    ? process.env.CURSOR_SESSION_ID
    : host === "omp"
      ? process.env.OMP_SESSION_PATH || process.env.PI_CODING_AGENT_SESSION_FILE || process.env.OMP_SESSION_ID
      : host === "claude"
        ? process.env.CLAUDE_SESSION_ID
        : process.env.CODEX_SESSION_ID || process.env.CODEX_THREAD_ID;
  const selected = requests.length ? requests : metadata ? [metadata] : [];
  if (!selected.length) return { host, sessions: [], gaps: [`current ${host} session identity is unavailable; full history was not established`] };
  const paths = [...new Set(selected.map((request) => requestedFile(host, request, roots, cwd)))];
  const sessions = paths.flatMap((path) => {
    if (host === "cursor") return cursorSession(path);
    if (host === "omp") return ompSession(path, cwd);
    const found = [{ path, records: genericRecords(path, host, true, cwd) }];
    if (host === "claude") {
      const childRoot = path.slice(0, -extname(path).length);
      for (const child of files(join(childRoot, "subagents"), (file) => extname(file) === ".jsonl")) {
        found.push({ path: child, records: genericRecords(child, host, false, cwd) });
      }
    }
    return found;
  });
  return { host, sessions, gaps: [] };
}

try {
  const { values } = parseArgs({
    options: {
      host: { type: "string" },
      cwd: { type: "string" },
      session: { type: "string", multiple: true, default: [] },
    },
    strict: true,
  });
  if (!HOSTS.has(values.host)) fail(`unknown host: ${values.host ?? "missing"}`);
  if (!values.cwd || !isAbsolute(values.cwd)) fail("--cwd must be an absolute path");
  process.stdout.write(`${JSON.stringify(evidence(values.host, resolve(values.cwd), values.session))}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
