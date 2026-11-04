import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../..");

const EXACT_DEPENDENCIES = {
  ai: "7.0.162",
  "@ai-sdk/anthropic": "4.0.96",
  zod: "4.6.7",
} as const;

const FORBIDDEN_PACKAGES = new Set([
  "@anthropic-ai/sdk",
  "langchain",
  "langgraph",
]);

describe("shopper assistant dependencies", () => {
  it("pins ai, @ai-sdk/anthropic and zod to exact versions", () => {
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const dependencies = manifest.dependencies ?? {};

    for (const [name, version] of Object.entries(EXACT_DEPENDENCIES)) {
      const specifier = dependencies[name];
      expect(specifier, `${name} is a direct dependency`).toBe(version);
      expect(specifier).not.toMatch(/[\^~x*]/);
    }
  });

  it("lockfile resolves one zod and no LangChain or Anthropic SDK packages", () => {
    const lockfile = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
    const resolved = resolvedPackages(lockfile);

    expect([...(resolved.get("zod") ?? [])]).toEqual(["4.6.7"]);

    for (const name of resolved.keys()) {
      expect(FORBIDDEN_PACKAGES.has(name) || name.startsWith("@langchain/")).toBe(false);
    }

    const productionSources = sourceFiles(path.join(root, "src")).filter(
      (file) => !file.endsWith(".test.ts"),
    );
    for (const file of productionSources) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(
        /from\s+["'](?:@anthropic-ai\/sdk|langchain|@langchain\/[^"']+|langgraph)["']/,
      );
    }
  });
});

function resolvedPackages(lockfile: string): Map<string, Set<string>> {
  const normalized = lockfile.replace(/\r\n/g, "\n");
  const packagesStart = normalized.indexOf("\npackages:\n");
  const snapshotsStart = normalized.indexOf("\nsnapshots:\n");
  expect(packagesStart).toBeGreaterThan(-1);
  expect(snapshotsStart).toBeGreaterThan(packagesStart);
  const section = normalized.slice(packagesStart, snapshotsStart);
  const resolved = new Map<string, Set<string>>();

  for (const line of section.split("\n")) {
    const match = line.match(/^  '?((?:@[^/']+\/)?[^@']+)@([^'(:]+)'?:/);
    if (!match) continue;
    const name = match[1];
    const version = match[2];
    if (name === undefined || version === undefined) continue;
    const versions = resolved.get(name) ?? new Set<string>();
    versions.add(version);
    resolved.set(name, versions);
  }

  return resolved;
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}
