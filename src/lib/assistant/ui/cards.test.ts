import { describe, expect, it } from "vitest";
import { cardsFromParts } from "./cards";

const text = { type: "text", text: "The palm oil is $1.00 and <img onerror=x> [buy](http://evil)" };

describe("assistant cards", () => {
  it("maps every tool part state to exactly one card kind", () => {
    const cards = cardsFromParts([
      text,
      { type: "tool-search_catalog", toolCallId: "s1", state: "input-streaming", input: { query: "egusi" } },
      { type: "tool-show_products", toolCallId: "p1", state: "input-available", input: { listing_ids: ["a"] } },
      {
        type: "tool-search_catalog",
        toolCallId: "s2",
        state: "output-available",
        input: { query: "egusi" },
        output: {
          ok: true,
          items: [{
            listingId: "l1",
            name: "Egusi",
            variantId: "v1",
            packLabel: "400 g",
            priceCents: 500,
            imageUrl: null,
            mayBeUnavailable: true,
          }],
        },
      },
      {
        type: "tool-show_products",
        toolCallId: "p2",
        state: "output-available",
        output: {
          ok: true,
          cards: [{
            listingId: "l2",
            name: "Stockfish",
            imageUrl: "/images/stock.jpg",
            mayBeUnavailable: false,
            variants: [
              { variantId: "v-b", label: "Large", priceCents: 900 },
              { variantId: "v-a", label: "Small", priceCents: 700 },
            ],
          }],
          notFound: ["missing-listing"],
        },
      },
      {
        type: "tool-add_to_cart",
        toolCallId: "a1",
        state: "output-available",
        output: {
          ok: true,
          items: [{
            ok: true,
            added: 2,
            lineId: "line-1",
            name: "Egusi",
            packLabel: "400 g",
            limitedTo: 4,
          }],
        },
      },
      {
        type: "tool-offer_choices",
        toolCallId: "c1",
        state: "output-available",
        output: {
          ok: true,
          options: [
            { listingId: "l1", variantId: "v1", name: "Egusi", packLabel: "400 g" },
            { listingId: "l2", variantId: "v2", name: "Garri", packLabel: "1 kg" },
          ],
          notFound: [],
        },
      },
      {
        type: "tool-get_cart_summary",
        toolCallId: "g1",
        state: "output-available",
        output: {
          ok: true,
          lines: [{ lineId: "line-1", name: "Egusi", packLabel: "400 g", qty: 2, lineTotalCents: 1000 }],
          subtotalCents: 1000,
          minimumOrderCents: 3500,
          minimumMet: false,
          missingCents: 2500,
        },
      },
      {
        type: "tool-search_catalog",
        toolCallId: "e1",
        state: "output-error",
        errorText: "provider exploded <script>",
      },
      { type: "tool-prepare_checkout", toolCallId: "u1", state: "output-available", output: { ok: true } },
      { type: "data-step-limit", data: { text: "I've done as much as I can in one go. Tell me what you'd like next." } },
    ]);

    expect(cards.map((card) => card.kind)).toEqual([
      "skeleton",
      "skeleton",
      "product",
      "product",
      "missing",
      "added",
      "choices",
      "summary",
      "tool-error",
    ]);
    const error = cards.find((card) => card.kind === "tool-error");
    expect(error).toMatchObject({ message: "Sorry, something went wrong. Please try again." });
    expect(JSON.stringify(cards)).not.toContain("provider exploded");
    expect(JSON.stringify(cards)).not.toContain("missing-listing");
    expect(JSON.stringify(cards)).not.toContain("$1.00");
    const shown = cards.find((card) => card.kind === "product" && card.name === "Stockfish");
    expect(shown).toMatchObject({ packLabel: "Small", priceCents: 700, priceLabel: "$7.00" });
    const choices = cards.find((card) => card.kind === "choices");
    expect(choices && choices.kind === "choices" ? choices.options.map((option) => option.sendText) : []).toEqual([
      "Egusi (400 g)",
      "Garri (1 kg)",
    ]);
  });

  it("card prices come only from tool output", () => {
    const cards = cardsFromParts([
      { type: "text", text: "Only $1.00 today, or 50 cents." },
      {
        type: "tool-search_catalog",
        toolCallId: "s",
        state: "output-available",
        input: { query: "egusi" },
        output: {
          items: [{ name: "Egusi", packLabel: "Each", priceCents: 1, imageUrl: null, mayBeUnavailable: false }],
        },
      },
    ]);
    expect(cards).toEqual([
      expect.objectContaining({ kind: "product", priceCents: 1, priceLabel: "$0.01" }),
    ]);
    const pricey = cardsFromParts([{
      type: "tool-show_products",
      toolCallId: "p",
      state: "output-available",
      output: {
        cards: [{
          name: "Yam",
          imageUrl: null,
          variants: [{ variantId: "v", label: "Tuber", priceCents: 99999 }],
        }],
      },
    }]);
    expect(pricey[0]).toMatchObject({ priceLabel: "$999.99" });
  });

  it("added card falls back when stored output predates the enriched fields", () => {
    const cards = cardsFromParts([{
      type: "tool-add_to_cart",
      toolCallId: "old",
      state: "output-available",
      output: { ok: true, added: 3, lineId: "line-old", qty: 3, swapRule: "exact_only" },
    }]);
    expect(cards).toEqual([
      expect.objectContaining({
        kind: "added",
        legacy: true,
        name: "Added to cart · Qty 3",
        lineId: "line-old",
        additionId: "old:0",
        qtyAdded: 3,
      }),
    ]);
  });

  it("summary card shows the tool subtotal without recomputing", () => {
    const cards = cardsFromParts([{
      type: "tool-get_cart_summary",
      toolCallId: "sum",
      state: "output-available",
      output: {
        ok: true,
        lines: [
          { lineId: "a", name: "Egusi", packLabel: "Each", qty: 1, lineTotalCents: 100 },
          { lineId: "b", name: "Garri", packLabel: "Each", qty: 1, lineTotalCents: 100 },
        ],
        subtotalCents: 250,
        minimumOrderCents: 250,
        minimumMet: true,
        missingCents: 0,
      },
    }]);
    expect(cards[0]).toMatchObject({
      kind: "summary",
      subtotalCents: 250,
      subtotalLabel: "$2.50",
      minimumMet: true,
      missingLabel: "$0.00",
    });
  });

  it("maps partial all-failed singleton-alias and zero-variant tool outputs safely", () => {
    const cards = cardsFromParts([
      {
        type: "tool-add_to_cart",
        toolCallId: "mix",
        state: "output-available",
        output: {
          ok: true,
          added: 1,
          lineId: "should-not-duplicate",
          name: "Alias",
          items: [
            { ok: true, added: 1, lineId: "line-a", name: "Egusi", packLabel: "Each" },
            { ok: false, code: "variant_not_found", message: "That item is not in this store." },
          ],
        },
      },
      {
        type: "tool-add_to_cart",
        toolCallId: "none",
        state: "output-available",
        output: {
          ok: true,
          items: [{ ok: false, code: "unavailable", message: "That product is unavailable." }],
        },
      },
      {
        type: "tool-show_products",
        toolCallId: "empty",
        state: "output-available",
        output: { ok: true, cards: [{ name: "Bare", imageUrl: null, variants: [] }], notFound: [] },
      },
      {
        type: "tool-offer_choices",
        toolCallId: "few",
        state: "output-available",
        output: { ok: false, code: "not_enough_choices", message: "There are not enough choices to pick from." },
      },
    ]);
    expect(cards.filter((card) => card.kind === "added")).toHaveLength(1);
    expect(JSON.stringify(cards)).not.toContain("should-not-duplicate");
    expect(cards.filter((card) => card.kind === "missing").map((card) => card.kind === "missing" ? card.message : "")).toEqual([
      "That item is not in this store.",
      "That product is unavailable.",
      "There are not enough choices to pick from.",
    ]);
    const twins = cardsFromParts([{
      type: "tool-offer_choices",
      toolCallId: "twin",
      state: "output-available",
      output: {
        ok: true,
        options: [
          { listingId: "l1", variantId: "variant-aaaa", name: "Rice", packLabel: "Bag" },
          { listingId: "l2", variantId: "variant-bbbb", name: "Rice", packLabel: "Bag" },
        ],
      },
    }]);
    const choice = twins.find((card) => card.kind === "choices");
    expect(choice && choice.kind === "choices" ? choice.options.map((option) => option.sendText) : []).toEqual([
      "Rice (Bag) · aaaa",
      "Rice (Bag) · bbbb",
    ]);
  });
});
