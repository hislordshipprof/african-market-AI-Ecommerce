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
  } else if (command === "keys") {
    const [ticket, ticketEnv] = args;
    if (!ticket || !ticketEnv) fail("usage: keys <ticket> <ticket-env>");
    for (const key of ticketKeys(readFileSync(ticketEnv, "utf8"), ticket)) {
      process.stdout.write(`${key}\n`);
    }
  } else {
    fail("usage: lane-env.mjs filter|child-env|keys ...");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "failed";
  if (message.startsWith("lane-env:")) process.stderr.write(`${message}\n`);
  else process.stderr.write("lane-env: filter failed\n");
  process.exit(1);
}

function filterFile(ticket, src, dest, ticketEnv) {
  if (!existsSync(src) || !existsSync(ticketEnv)) {
    rmSync(dest, { force: true });
    fail("lane-env: source is missing");
  }
  const allowWrite = ticketAllowsR2Write(readFileSync(ticketEnv, "utf8"), ticket);
  const drop = new Set(allowWrite ? ALWAYS_DROP : [...ALWAYS_DROP, ...WRITE_KEYS]);
  let text = readFileSync(src, "utf8");
  let bom = "";
  if (text.startsWith("\uFEFF")) {
    bom = "\uFEFF";
    text = text.slice(1);
  }
  const parts = text.split("\n");
  const kept = [];
  const withheld = new Set();
  let first = true;
  for (const part of parts) {
    const key = assignmentKey(part.replace(/\r$/, ""));
    if (key && drop.has(key)) {
      withheld.add(key);
      first = false;
      continue;
    }
    kept.push(first && bom ? bom + part : part);
    first = false;
  }
  const tmp = `${dest}.lane-env.tmp`;
  try {
    writeFileSync(tmp, kept.join("\n"));
    rmSync(dest, { force: true });
    writeFileSync(dest, kept.join("\n"));
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

function assignmentKey(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/);
  return match ? match[1] : null;
}

function fail(message) {
  throw new Error(message);
}
