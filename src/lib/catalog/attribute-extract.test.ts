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

import { createFakeAnthropicFetch, type FakeAnthropicStep } from "../assistant/messages-api-double";
import { extractProductAttributes } from "./attribute-extract";

function script(steps: FakeAnthropicStep[]) {
  const fake = createFakeAnthropicFetch({ expectedKey: "sk-ant-test", steps });
  fakeState.fetch = fake.fetch;
  return fake;
}

describe("product attribute extraction (fake Messages API)", () => {
  beforeAll(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("ASSISTANT_MODEL", "");
  });
  afterAll(() => vi.unstubAllEnvs());

  it("sends the label photo and description, and keeps only the US top 9 and known claims", async () => {
    const fake = script([{
      kind: "tool",
      toolName: "product_attributes",
      toolInput: {
        ingredients: [" Palm Oil ", "Onion", ""],
        allergens: ["peanuts", "mustard"],
        dietaryClaims: ["halal", "organic"],
      },
    }]);
    const proposed = await extractProductAttributes({
      name: "Suya spice",
      description: "Ground peanut, onion and pepper blend. Halal certified.",
      imageUrl: "https://images.example.com/suya-label.jpg",
    });
    expect(proposed).toEqual({
      ingredients: ["palm oil", "onion"],
      allergens: ["peanuts"],
      dietaryClaims: ["halal"],
    });
    const body = fake.requests[0]!.body!;
    const text = JSON.stringify(body.messages);
    expect(text).toContain("Ground peanut, onion and pepper blend");
    expect(text).toContain("https://images.example.com/suya-label.jpg");
    expect(body.tool_choice).toMatchObject({ type: "tool", name: "product_attributes" });
  });

  it("a group the model cannot read comes back null, so it stays unknown", async () => {
    script([{
      kind: "tool",
      toolName: "product_attributes",
      toolInput: { ingredients: null, allergens: null, dietaryClaims: ["vegan"] },
    }]);
    expect(await extractProductAttributes({ name: "Gari", description: null, imageUrl: null })).toEqual({
      ingredients: null,
      allergens: null,
      dietaryClaims: ["vegan"],
    });

    script([{ kind: "text", text: "I cannot read this label." }]);
    expect(await extractProductAttributes({ name: "Gari", description: null, imageUrl: null })).toEqual({
      ingredients: null,
      allergens: null,
      dietaryClaims: null,
    });
  });
});
