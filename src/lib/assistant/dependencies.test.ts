import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../..");

function readJson(relative: string): { dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(path.join(root, relative), "utf8")) as {
    dependencies?: Record<string, string>;
  };
}

const FORBIDDEN = [
  "@anthropic-ai/sdk",
  "langchain",
  "@langchain/core",
  "@langchain/langgraph",
  "langgraph",
];

describe("assistant dependencies", () => {
  it("pins ai, @ai-sdk/anthropic and zod to exact versions", () => {
    const pkg = readJson("package.json");
    const deps = pkg.dependencies ?? {};
    for (const name of ["ai", "@ai-sdk/anthropic", "zod"] as const) {
      const version = deps[name];
      expect(version, `${name} is a direct dependency`).toBeTruthy();
      expect(version, `${name} is pinned exactly`).not.toMatch(/^[\^~]/);
      expect(version, `${name} is an exact version`).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(deps.ai).toBe("7.0.162");
    expect(deps["@ai-sdk/anthropic"]).toBe("4.0.96");
    expect(deps.zod).toBe("4.6.7");
  });

  it("lockfile resolves one zod and no LangChain or Anthropic SDK packages", () => {
    const lock = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
    const resolved = [...lock.matchAll(/^  (zod@[\d.]+):$/gm)].map((match) => match[1]);
    expect(resolved).toEqual(["zod@4.6.7"]);
    for (const name of FORBIDDEN) {
      expect(lock.includes(`/${name}@`) || lock.includes(`${name}@`), name).toBe(false);
      expect(lock.includes(`  ${name}:`), name).toBe(false);
    }
    const pkg = readJson("package.json");
    const declared = { ...pkg.dependencies };
    for (const name of FORBIDDEN) {
      expect(declared[name]).toBeUndefined();
    }
  });
});
