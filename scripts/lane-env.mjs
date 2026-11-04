#!/usr/bin/env node
// Lane .env filter. No dependencies. Never prints secret values.
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";

const WRITE_KEYS = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
const ALWAYS_DROP = ["SEED_PRUNE_R2", "DATABASE_URL_UNPOOLED"];

const [command, ...args] = process.argv.slice(2);

try {
  if (command === "filter") {
    const [ticket, src, dest, ticketEnv] = args;
    if (!ticket || !src || !dest || !ticketEnv) fail("usage: filter <ticket> <src> <dest> <ticket-env>");
    filterFile(ticket, src, dest, ticketEnv);
  } else if (command === "child-env") {
    const [ticket, ticketEnv] = args;
    if (!ticket || !ticketEnv) fail("usage: child-env <ticket> <ticket-env>");
    const allowWrite = ticketAllowsR2Write(readFileSync(ticketEnv, "utf8"), ticket);
    const names = [...ALWAYS_DROP, ...(allowWrite ? [] : WRITE_KEYS)];
    for (const name of names) process.stdout.write(`unset ${name}\n`);
  } else if (command === "strip") {
    const [file, ...keys] = args;
    if (!file || keys.length === 0) fail("usage: strip <file> <key>...");
    const original = readFileSync(file, "utf8");
    const { text } = stripAssignments(original, new Set(keys));
    writeFileSync(file, text);
  } else if (command === "keys") {
    const [ticket, ticketEnv] = args;
    if (!ticket || !ticketEnv) fail("usage: keys <ticket> <ticket-env>");
    for (const key of ticketKeys(readFileSync(ticketEnv, "utf8"), ticket)) {
      process.stdout.write(`${key}\n`);
    }
  } else {
    fail("usage: lane-env.mjs filter|child-env|keys|strip ...");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "failed";
  if (message.startsWith("lane-env:") || message.startsWith("usage:")) process.stderr.write(`${message}\n`);
  else process.stderr.write("lane-env: filter failed\n");
  process.exit(1);
}

function filterFile(ticket, src, dest, ticketEnv) {
  if (!existsSync(src) || !existsSync(ticketEnv)) {
    rmSync(dest, { force: true });
    fail("lane-env: source is missing");
  }
  let ticketText;
  let text;
  try {
    ticketText = readFileSync(ticketEnv, "utf8");
    text = readFileSync(src, "utf8");
  } catch {
    rmSync(dest, { force: true });
    fail("lane-env: source is missing");
  }
  const allowWrite = ticketAllowsR2Write(ticketText, ticket);
  const drop = new Set(allowWrite ? ALWAYS_DROP : [...ALWAYS_DROP, ...WRITE_KEYS]);
  let bom = "";
  if (text.startsWith("\uFEFF")) {
    bom = "\uFEFF";
    text = text.slice(1);
  }
  const { text: kept, withheld } = stripAssignments(text, drop);
  const tmp = `${dest}.lane-env.tmp`;
  try {
    writeFileSync(tmp, bom + kept);
    rmSync(dest, { force: true });
    writeFileSync(dest, bom + kept);
    rmSync(tmp, { force: true });
  } catch {
    rmSync(tmp, { force: true });
    rmSync(dest, { force: true });
    fail("lane-env: could not write destination");
  }
  for (const name of withheld) process.stdout.write(`withheld ${name}\n`);
}

export function ticketAllowsR2Write(ticketEnvText, ticket) {
  return ticketKeys(ticketEnvText, ticket).some((key) => WRITE_KEYS.includes(key));
}

function ticketKeys(ticketEnvText, ticket) {
  const keys = [];
  for (const rawLine of ticketEnvText.split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const beforeComment = trimmed.split(/\s+#/)[0] ?? "";
    const tokens = beforeComment.trim().split(/\s+/).filter(Boolean);
    if (tokens[0] !== ticket) continue;
    keys.push(...tokens.slice(1));
  }
  return keys;
}

function stripAssignments(text, drop) {
  // dotenv rewrites \r\n and lone \r to \n before LINE. Match that text, then
  // delete the same span in the original so a continuation value is removed.
  const { norm, toOrig } = normalizeNewlines(text);
  const line = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/dmg;
  let out = "";
  let cursor = 0;
  const withheld = new Set();
  for (const match of norm.matchAll(line)) {
    const key = match[1];
    if (!key || !drop.has(key)) continue;
    withheld.add(key);
    const normStart = match.index ?? 0;
    const start = toOrig[normStart] ?? text.length;
    const end = toOrig[assignmentEnd(norm, match)] ?? text.length;
    if (start < cursor) continue;
    out += text.slice(cursor, start);
    cursor = end;
  }
  out += text.slice(cursor);
  return { text: out, withheld };
}

function normalizeNewlines(text) {
  let norm = "";
  const toOrig = [];
  for (let i = 0; i < text.length; i++) {
    toOrig.push(i);
    if (text[i] === "\r") {
      norm += "\n";
      if (text[i + 1] === "\n") i += 1;
    } else {
      norm += text[i];
    }
  }
  return { norm, toOrig };
}

function assignmentEnd(norm, match) {
  const valueEnd = match.indices?.[2]?.[1];
  let end = valueEnd ?? (match.index ?? 0) + match[0].length;
  if (valueEnd != null) {
    while (norm[end] === " " || norm[end] === "\t") end += 1;
    if (norm[end] === "#") {
      while (end < norm.length && norm[end] !== "\n") end += 1;
    }
  }
  if (norm[end] === "\n") end += 1;
  return end;
}

function fail(message) {
  throw new Error(message);
}
