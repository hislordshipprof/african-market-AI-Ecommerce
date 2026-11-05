import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storeScoped } from "../db";
import { assistantMessageFromActions } from "../assistant/replay";
import { cardsFromParts } from "../assistant/ui/cards";
import { addLine, CartError, getCartWithLines, undoAssistantAddition } from "./service";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("assistant addition undo", () => {
  let raw: PrismaClient;
  let storeA = "";
  let storeB = "";
  let cartA = "";
  let cartOther = "";
  let variant = "";

  beforeAll(async () => {
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    const suffix = randomUUID().slice(0, 8);
    const a = await raw.store.create({
      data: { slug: `undo-a-${suffix}`, name: "Undo A", themePreset: "palm-and-shea" },
    });
    const b = await raw.store.create({
      data: { slug: `undo-b-${suffix}`, name: "Undo B", themePreset: "lagoon-and-coral" },
    });
    storeA = a.id;
    storeB = b.id;
    cartA = (await storeScoped(storeA).cart.create({ data: { storeId: storeA, source: "manual" } })).id;
    cartOther = (await storeScoped(storeA).cart.create({ data: { storeId: storeA, source: "manual" } })).id;
    const listing = await storeScoped(storeA).listing.create({
      data: {
        storeId: storeA,
        customName: "Undo Yam",
        price: 100,
        stockMode: "unlimited",
        confidence: 1,
        active: true,
        frozen: false,
        perishable: false,
      },
    });
    variant = (await storeScoped(storeA).listingVariant.create({
      data: { listingId: listing.id, label: "Each", price: 100, weightG: 100 },
    })).id;
  });

  afterAll(async () => {
    for (const id of [storeA, storeB]) {
      if (!id) continue;
      await storeScoped(id).assistantUndoReceipt.deleteMany({});
      await storeScoped(id).cart.deleteMany({});
      await storeScoped(id).listing.deleteMany({});
    }
    if (raw) {
      await raw.store.deleteMany({ where: { id: { in: [storeA, storeB] } } });
      await raw.$disconnect();
    }
  });

  it("assistant Undo subtracts atomically and consumes one addition once after lost acknowledgement", async () => {
    await addLine(storeA, cartA, variant, 3, null);
    const line = (await getCartWithLines(storeA, cartA))!.lines[0]!;
    const first = await undoAssistantAddition(storeA, cartA, line.id, 2, "add-once", null);
    expect(first).toEqual({ status: "confirmed", qty: 1, removed: false });
    const second = await undoAssistantAddition(storeA, cartA, line.id, 2, "add-once", null);
    expect(second).toEqual({ status: "already_consumed", subtracted: 2 });
    expect((await storeScoped(storeA).cartLine.findUnique({ where: { id: line.id } }))?.qty).toBe(1);
  });

  it("recovery keeps one addition identity so a second undo does not subtract again", async () => {
    const cart = (await storeScoped(storeA).cart.create({ data: { storeId: storeA, source: "manual" } })).id;
    await addLine(storeA, cart, variant, 5, null);
    const line = (await getCartWithLines(storeA, cart))!.lines[0]!;
    const message = assistantMessageFromActions([{
      id: "audit-row-123",
      tool: "add_to_cart",
      input: { _call: "original-provider-call", items: [] },
      output: { ok: true, items: [{ ok: true, lineId: line.id, added: 2, name: "Undo Yam" }] },
    }]);
    const added = cardsFromParts(message.parts).find((card) => card.kind === "added");
    expect(added).toMatchObject({ additionId: "original-provider-call:0", lineId: line.id });
    const first = await undoAssistantAddition(storeA, cart, line.id, 2, "original-provider-call:0", null);
    expect(first).toEqual({ status: "confirmed", qty: 3, removed: false });
    const replayed = await undoAssistantAddition(storeA, cart, line.id, 2, "original-provider-call:0", null);
    expect(replayed).toEqual({ status: "already_consumed", subtracted: 2 });
    expect((await storeScoped(storeA).cartLine.findUnique({ where: { id: line.id } }))?.qty).toBe(3);
  });

  it("a legacy action without a provider call id still undoes once under the audit id", async () => {
    const cart = (await storeScoped(storeA).cart.create({ data: { storeId: storeA, source: "manual" } })).id;
    await addLine(storeA, cart, variant, 4, null);
    const line = (await getCartWithLines(storeA, cart))!.lines[0]!;
    const message = assistantMessageFromActions([{
      id: "audit-row-legacy",
      tool: "add_to_cart",
      input: { items: [] },
      output: { ok: true, items: [{ ok: true, lineId: line.id, added: 1, name: "Undo Yam" }] },
    }]);
    const added = cardsFromParts(message.parts).find((card) => card.kind === "added");
    expect(added).toMatchObject({ additionId: "audit-row-legacy:0" });
    const first = await undoAssistantAddition(storeA, cart, line.id, 1, "audit-row-legacy:0", null);
    expect(first.status).toBe("confirmed");
    const second = await undoAssistantAddition(storeA, cart, line.id, 1, "audit-row-legacy:0", null);
    expect(second.status).toBe("already_consumed");
    expect((await storeScoped(storeA).cartLine.findUnique({ where: { id: line.id } }))?.qty).toBe(3);
  });

  it("Undo is bound to the original line and cannot touch another cart in the same store", async () => {
    await addLine(storeA, cartOther, variant, 4, null);
    const other = (await getCartWithLines(storeA, cartOther))!.lines[0]!;
    await storeScoped(storeA).cartLine.delete({ where: { id: other.id } });
    await addLine(storeA, cartOther, variant, 4, null);
    const recreated = (await getCartWithLines(storeA, cartOther))!.lines[0]!;
    const result = await undoAssistantAddition(storeA, cartA, other.id, 2, "old-line", null);
    expect(result.status).toBe("already_removed");
    expect((await storeScoped(storeA).cartLine.findUnique({ where: { id: recreated.id } }))?.qty).toBe(4);
    await expect(undoAssistantAddition(storeA, cartA, recreated.id, 1, "wrong-cart", null)).rejects.toBeInstanceOf(CartError);
    expect((await storeScoped(storeA).cartLine.findUnique({ where: { id: recreated.id } }))?.qty).toBe(4);
  });

  it("foreign-store quantity update rejects and removal cannot change the foreign line", async () => {
    const foreignCart = (await storeScoped(storeB).cart.create({ data: { storeId: storeB, source: "manual" } })).id;
    const listing = await storeScoped(storeB).listing.create({
      data: {
        storeId: storeB,
        customName: "Foreign",
        price: 50,
        stockMode: "unlimited",
        confidence: 1,
        active: true,
        frozen: false,
        perishable: false,
      },
    });
    const foreignVariant = (await storeScoped(storeB).listingVariant.create({
      data: { listingId: listing.id, label: "Each", price: 50, weightG: 100 },
    })).id;
    await addLine(storeB, foreignCart, foreignVariant, 2, null);
    const foreignLine = (await getCartWithLines(storeB, foreignCart))!.lines[0]!;
    const { updateLineQty, removeLine } = await import("./service");
    await expect(updateLineQty(storeA, cartA, foreignLine.id, 1, null)).rejects.toBeInstanceOf(CartError);
    await removeLine(storeA, cartA, foreignLine.id, null);
    expect((await storeScoped(storeB).cartLine.findUnique({ where: { id: foreignLine.id } }))?.qty).toBe(2);
  });
});
