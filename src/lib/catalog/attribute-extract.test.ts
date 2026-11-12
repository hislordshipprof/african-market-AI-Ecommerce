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

  it("sends the label photo and description, and keeps the US top 9 and known claims", async () => {
    const fake = script([{
      kind: "tool",
      toolName: "product_attributes",
      toolInput: {
        ingredients: [" Palm Oil ", "Onion", ""],
        allergens: ["peanuts"],
        dietaryClaims: ["halal"],
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
    expect(JSON.stringify(body.tools)).toContain("crustacean_shellfish");
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

  it("an allergen or claim off the enum leaves that whole group unread, never an empty list", async () => {
    script([{
      kind: "tool",
      toolName: "product_attributes",
      toolInput: { ingredients: ["groundnut"], allergens: ["Peanuts", "tree nuts"], dietaryClaims: ["halal"] },
    }]);
    expect(await extractProductAttributes({ name: "Suya spice", description: null, imageUrl: null })).toEqual({
      ingredients: ["groundnut"],
      allergens: null,
      dietaryClaims: ["halal"],
    });

    script([{
      kind: "tool",
      toolName: "product_attributes",
      toolInput: { ingredients: null, allergens: ["peanuts", "mustard"], dietaryClaims: ["halal", "organic"] },
    }]);
    expect(await extractProductAttributes({ name: "Suya spice", description: null, imageUrl: null })).toEqual({
      ingredients: null,
      allergens: null,
      dietaryClaims: null,
    });
  });

  it("an ingredient list over the cap is unread, not cut short", async () => {
    const seventy = Array.from({ length: 70 }, (_, i) => `ingredient ${i + 1}`);
    script([{
      kind: "tool",
      toolName: "product_attributes",
      toolInput: { ingredients: seventy, allergens: [], dietaryClaims: null },
    }]);
    expect(await extractProductAttributes({ name: "Stock cube", description: null, imageUrl: null })).toEqual({
      ingredients: null,
      allergens: [],
      dietaryClaims: null,
    });
  });

  it("an ingredient list of only blank names is unread, never 'no ingredients'", async () => {
    script([{
      kind: "tool",
      toolName: "product_attributes",
      toolInput: { ingredients: [" ", ""], allergens: null, dietaryClaims: null },
    }]);
    expect(await extractProductAttributes({ name: "Ogiri", description: null, imageUrl: null })).toEqual({
      ingredients: null,
      allergens: null,
      dietaryClaims: null,
    });
  });
});
