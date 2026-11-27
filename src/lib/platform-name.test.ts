import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("platform name (#871)", () => {
  it("no app source says the old platform name", () => {
    const old = /African Markets/i;
    const hits = sourceFiles("src").filter((file) => old.test(readFileSync(file, "utf8")));
    expect(hits).toEqual([]);
  });
});
