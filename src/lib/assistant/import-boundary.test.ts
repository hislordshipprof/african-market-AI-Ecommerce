import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ASSISTANT_TOOL_NAMES } from "./contract";
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

  it("fails on a side-effect stripe import and a checkout service import", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-boundary-"));
    temps.push(root);
    const src = path.join(root, "src");
    fs.mkdirSync(path.join(src, "lib/assistant"), { recursive: true });
    fs.writeFileSync(path.join(src, "lib/assistant/side-effect.ts"), 'import "stripe";\nexport const side = 1;\n');
    fs.writeFileSync(
      path.join(src, "lib/assistant/checkout-leak.ts"),
      'import "@/lib/checkout/service";\nexport const checkout = 1;\n',
    );
    const hits = findForbiddenImports([path.join(src, "lib/assistant")], src);
    expect(hits.join("\n")).toContain("stripe");
    expect(hits.join("\n")).toContain("checkout/service");
  });

  it("the registry is exactly the 19 tools, none of which pays or places an order (#247)", () => {
    expect(ASSISTANT_TOOL_NAMES).toHaveLength(19);
    expect(ASSISTANT_TOOL_NAMES.slice(-3)).toEqual(["get_fulfillment_options", "set_fulfillment", "prepare_checkout"]);
    expect(ASSISTANT_TOOL_NAMES.filter((name) => /pay|place|order_now|confirm/.test(name))).toEqual([]);
  });

  it("a sabotage import in a tool file reached from the registry fails the walk (#247)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-boundary-"));
    temps.push(root);
    const src = path.join(root, "src");
    fs.mkdirSync(path.join(src, "lib/assistant/tools"), { recursive: true });
    fs.mkdirSync(path.join(src, "lib/checkout"), { recursive: true });
    fs.mkdirSync(path.join(src, "app/api/assistant/chat"), { recursive: true });
    fs.writeFileSync(path.join(src, "lib/checkout/quote.ts"), "export const quote = 1;\n");
    fs.writeFileSync(path.join(src, "lib/checkout/saved-card-payment.ts"), "export const pay = 1;\n");
    fs.writeFileSync(path.join(src, "lib/checkout/actions.ts"), "export const place = 1;\n");
    fs.writeFileSync(path.join(src, "lib/checkout/service.ts"), "export const placeOrder = 1;\n");
    fs.writeFileSync(path.join(src, "lib/assistant/tools/index.ts"), 'export * from "./checkout";\n');
    fs.writeFileSync(path.join(src, "app/api/assistant/chat/route.ts"), 'import "@/lib/assistant/tools";\n');
    fs.writeFileSync(
      path.join(src, "lib/assistant/tools/checkout.ts"),
      'import { quote } from "../../checkout/quote";\nexport const prepare = quote;\n',
    );
    const roots = [path.join(src, "app/api/assistant")];
    expect(findForbiddenImports(roots, src)).toEqual([]);

    for (const sabotage of [
      'import { placeOrder } from "../../checkout/service";',
      'import { createPaymentIntentAction } from "@/lib/checkout/actions";',
      'import { pay } from "../../checkout/saved-card-payment";',
      'import Stripe from "stripe";',
      'const lazy = () => import("@/lib/stripe/provider");',
    ]) {
      fs.writeFileSync(
        path.join(src, "lib/assistant/tools/checkout.ts"),
        `${sabotage}\nimport { quote } from "../../checkout/quote";\nexport const prepare = quote;\n`,
      );
      expect(findForbiddenImports(roots, src), sabotage).not.toEqual([]);
    }
  });
});
