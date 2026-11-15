import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const fakeState = vi.hoisted(() => ({
  fetch: (async () => new Response("unscripted", { status: 500 })) as typeof fetch,
}));

vi.mock("../assistant/model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../assistant/model")>();
  return {
    ...actual,
    createAssistantModel: () => actual.createAssistantModel({ fetch: fakeState.fetch }),
  };
});

import sharp from "sharp";
import { createFakeAnthropicFetch, type FakeAnthropicStep } from "../assistant/messages-api-double";
import { extractReportItems } from "./owner-report";

function script(steps: FakeAnthropicStep[]) {
  const fake = createFakeAnthropicFetch({ expectedKey: "sk-ant-test", steps });
  fakeState.fetch = fake.fetch;
  return fake;
}

describe("owner report extraction (fake Messages API)", () => {
  beforeAll(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("ASSISTANT_MODEL", "");
  });
  afterAll(() => vi.unstubAllEnvs());

  it("a voice transcript becomes named items with whole quantities", async () => {
    const fake = script([{
      kind: "tool",
      toolName: "report_items",
      toolInput: { items: [{ name: "egusi", quantity: 20, unit: "bags" }, { name: "palm oil", quantity: 15, unit: "bottles" }] },
    }]);
    const extracted = await extractReportItems({ type: "voice", transcript: "Got 20 bags of egusi and 15 bottles of palm oil" });
    expect(extracted.items).toEqual([
      { name: "egusi", quantity: 20, unit: "bags" },
      { name: "palm oil", quantity: 15, unit: "bottles" },
    ]);
    const body = fake.requests[0]!.body!;
    expect(JSON.stringify(body.messages)).toContain("Got 20 bags of egusi");
    expect(body.tool_choice).toMatchObject({ type: "tool", name: "report_items" });
  });

  it("an invoice photo is sent as an image and its line items come back structured", async () => {
    const fake = script([{
      kind: "tool",
      toolName: "report_items",
      toolInput: { items: [{ name: "Egusi 5kg", quantity: 4 }, { name: "Gari 2kg", quantity: 10 }] },
    }]);
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    const extracted = await extractReportItems({ type: "invoice_photo", image: jpeg });
    expect(extracted.items).toEqual([
      { name: "Egusi 5kg", quantity: 4, unit: null },
      { name: "Gari 2kg", quantity: 10, unit: null },
    ]);
    const content = (fake.requests[0]!.body!.messages as Array<{ content: Array<{ type: string }> }>)[0]!.content;
    expect(content.some((block) => block.type === "image")).toBe(true);
  });

  it("unintelligible input returns no items and no error", async () => {
    script([{ kind: "tool", toolName: "report_items", toolInput: { items: [] } }]);
    expect((await extractReportItems({ type: "voice", transcript: "mmm hmm" })).items).toEqual([]);

    script([{ kind: "text", text: "I could not read that." }]);
    expect((await extractReportItems({ type: "voice", transcript: "..." })).items).toEqual([]);
  });

  it("a vague or fractional quantity keeps the item with no quantity", async () => {
    script([{
      kind: "tool",
      toolName: "report_items",
      toolInput: { items: [{ name: "yam", quantity: 2.5 }, { name: " ", quantity: 3 }, { name: "rice", quantity: null }] },
    }]);
    const extracted = await extractReportItems({ type: "voice", transcript: "two and a half yams, some rice" });
    expect(extracted.items).toEqual([
      { name: "yam", quantity: null, unit: null },
      { name: "rice", quantity: null, unit: null },
    ]);
  });
});
