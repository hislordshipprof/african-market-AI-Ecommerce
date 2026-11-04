import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findForbiddenImports } from "./import-boundary";

const SRC = path.resolve(__dirname, "../..");
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("assistant import boundary", () => {
  it("assistant code cannot reach Stripe or placeOrder", () => {
    const hits = findForbiddenImports(
      [path.join(SRC, "lib/assistant"), path.join(SRC, "app/api/assistant")],
      SRC,
    );
    expect(hits).toEqual([]);
  });

  it("the walker fails when a forbidden import is added", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-boundary-"));
    temps.push(root);
    const src = path.join(root, "src");
    fs.mkdirSync(path.join(src, "lib/assistant"), { recursive: true });
    fs.writeFileSync(
      path.join(src, "lib/assistant/leak.ts"),
      'import Stripe from "stripe";\nexport const leak = Stripe;\n',
    );
    const hits = findForbiddenImports([path.join(src, "lib/assistant")], src);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.join("\n")).toContain("stripe");
  });
});
