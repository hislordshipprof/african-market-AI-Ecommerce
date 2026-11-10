import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const PUBLIC_ACTIONS = new Set([
  "src/lib/cart/actions.ts",
  "src/lib/checkout/actions.ts",
  "src/app/account/actions.ts",
]);
const GUARDS = ["requireStoreOwner", "requireStoreMember", "requirePlatformAdmin", "requireUserId"];
const HTTP = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "node_modules" && name !== ".next") walk(full, acc);
    } else if (name.endsWith(".ts") || name.endsWith(".tsx")) acc.push(full);
  }
  return acc;
}

function rel(file: string): string {
  return path.relative(root, file).replaceAll("\\", "/");
}

/** Function declarations and `export const name = async` arrows. Both are public actions. */
export function actionNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/export (?:async )?function (\w+)/g)) names.add(match[1]);
  for (const match of source.matchAll(/export const (\w+)\s*=\s*async\b/g)) names.add(match[1]);
  return [...names];
}

function actions(): Array<{ file: string; name: string; source: string }> {
  const found = [];
  for (const file of walk(path.join(root, "src"))) {
    const source = readFileSync(file, "utf8");
    if (!source.startsWith('"use server"') && !source.startsWith("'use server'")) continue;
    for (const name of actionNames(source)) {
      found.push({ file: rel(file), name, source });
    }
  }
  return found;
}

function routes(): Array<{ file: string; name: string; source: string }> {
  const found = [];
  for (const file of walk(path.join(root, "src", "app", "api"))) {
    if (!file.endsWith(`${path.sep}route.ts`)) continue;
    const source = readFileSync(file, "utf8");
    const fileRel = rel(file);
    for (const method of HTTP) {
      const declared = new RegExp(`export (?:async )?function ${method}\\b`).test(source)
        || new RegExp(`export const ${method}\\b`).test(source);
      if (declared) found.push({ file: fileRel, name: method, source });
    }
  }
  return found;
}

function declarationAt(source: string, name: string): number {
  const patterns = [
    new RegExp(`export (?:async )?function ${name}\\b`),
    new RegExp(`export const ${name}\\s*=\\s*async\\b`),
  ];
  for (const pattern of patterns) {
    const at = source.search(pattern);
    if (at >= 0) return at;
  }
  return -1;
}

function takesArguments(source: string, name: string): boolean {
  const start = declarationAt(source, name);
  if (start < 0) return false;
  const open = source.indexOf("(", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i).trim().length > 0;
    }
  }
  return false;
}

function functionBody(source: string, name: string): string {
  const start = declarationAt(source, name);
  const rest = source.slice(start + 1);
  const next = rest.search(/\nexport /);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

function hopSource(source: string): string {
  const match = source.match(/import\s*\{[^}]*createChatHandler[^}]*\}\s*from\s*["']([^"']+)["']/);
  if (!match) return source;
  const spec = match[1];
  const file = spec.startsWith("@/")
    ? path.join(root, "src", spec.slice(2))
    : path.resolve(path.dirname(source), spec);
  const withExt = file.endsWith(".ts") ? file : `${file}.ts`;
  return readFileSync(withExt, "utf8");
}

function routeReadsInput(file: string, source: string): boolean {
  if (file.includes("/api/inngest/")) return false;
  const implementation = source.includes("createChatHandler") ? hopSource(source) : source;
  return /(?:req|request)\.json\(|(?:req|request)\.text\(|searchParams|\bparams\b/.test(implementation);
}

function auditKeys(): Map<string, string> {
  const markdown = readFileSync(path.join(root, "docs", "security", "endpoint-audit.md"), "utf8");
  const rows = new Map<string, string>();
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("| `src/")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    const key = cells[0].replaceAll("`", "");
    if (rows.has(key)) throw new Error(`duplicate audit row ${key}`);
    rows.set(key, cells[cells.length - 1]);
  }
  return rows;
}

describe("endpoint inventory", () => {
  it("every exported server action and route method has one audit row", () => {
    const rows = auditKeys();
    const expected = [...actions(), ...routes()].map((item) => `${item.file} ${item.name}`);
    expect(expected.slice().sort()).toEqual([...rows.keys()].sort());
    for (const resolution of rows.values()) {
      expect(resolution).toMatch(/^(fixed in #309|listed, not fixed|checked in #\d+)$/);
    }
  });

  it('every "use server" export calls a guard or is on the public allow-list', () => {
    const missing = actions()
      .filter((item) => !PUBLIC_ACTIONS.has(item.file))
      .filter((item) => !GUARDS.some((guard) => functionBody(item.source, item.name).includes(guard)))
      .map((item) => `${item.file} ${item.name}`);
    expect(missing).toEqual([]);
  });

  it("every input-taking endpoint imports the shared parse helper", () => {
    const missing: string[] = [];
    for (const item of actions()) {
      if (!takesArguments(item.source, item.name)) continue;
      if (!item.source.includes('from "../security/parse-input"') && !item.source.includes('from "@/lib/security/parse-input"')) {
        missing.push(`${item.file} ${item.name}`);
      }
    }
    for (const item of routes()) {
      if (!routeReadsInput(item.file, item.source)) continue;
      const implementation = item.source.includes("createChatHandler") ? hopSource(item.source) : item.source;
      if (!implementation.includes("parse-input")) missing.push(`${item.file} ${item.name}`);
    }
    expect(missing).toEqual([]);
  });

  it("counts an exported async arrow as an endpoint", () => {
    const source = `"use server";\nexport const unauditedAction = async (input: unknown) => input;\n`;
    expect(actionNames(source)).toEqual(["unauditedAction"]);
    expect(takesArguments(source, "unauditedAction")).toBe(true);
  });
});
