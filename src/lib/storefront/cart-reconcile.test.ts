import { describe, expect, it } from "vitest";
import type { CartLine } from "@/lib/storefront/cart-store";
import {
  clearKeyIdentity,
  confirmedSnapshot,
  mergeServerLines,
  removalResultAction,
  type MergeInput,
} from "@/lib/storefront/cart-reconcile";

function line(partial: Partial<CartLine> & Pick<CartLine, "listingId" | "quantity">): CartLine {
  return {
    listingId: partial.listingId,
    variantId: partial.variantId ?? `${partial.listingId}-v`,
    name: partial.name ?? partial.listingId,
    price: partial.price ?? 100,
    quantity: partial.quantity,
    serverLineId: partial.serverLineId,
    swapRule: partial.swapRule,
    substituteVariantId: partial.substituteVariantId,
    packLabel: partial.packLabel,
    imageUrl: partial.imageUrl,
  };
}

const yellowKey = JSON.stringify(["yellow", "yellow-v"]);
const whiteKey = JSON.stringify(["white", "white-v"]);

function base(over: Partial<MergeInput> = {}): MergeInput {
  return {
    lines: [],
    confirmed: new Map(),
    pendingDelete: new Map(),
    dropAfterAdd: new Set(),
    revs: new Map(),
    identity: new Map(),
    serverLines: [],
    stamp: { revs: new Map(), identity: new Map() },
    mode: "keep-intent",
    ...over,
  };
}

describe("cart reconcile", () => {
  it("a returned removal rejection restores A and preserves B", () => {
    expect(removalResultAction("USER_NOT_FOUND")).toBe("rejected");
    expect(removalResultAction("CART_NOT_FOUND")).toBe("committed");
    expect(removalResultAction(null)).toBe("committed");

    const serverYellow = line({
      listingId: "yellow",
      variantId: "yellow-v",
      quantity: 1,
      serverLineId: "row-yellow",
      swapRule: "store_suggests",
      substituteVariantId: null,
      price: 699,
      name: "Yellow Garri",
      packLabel: "1 lb",
    });
    const whiteLocal = line({
      listingId: "white",
      variantId: "white-v",
      quantity: 2,
      serverLineId: "row-white",
      price: 500,
    });
    const merged = mergeServerLines(
      base({
        lines: [whiteLocal],
        confirmed: new Map([
          [yellowKey, { lineId: "row-yellow", qty: 1 }],
          [whiteKey, { lineId: "row-white", qty: 1 }],
        ]),
        pendingDelete: new Map([[yellowKey, "row-yellow"]]),
        revs: new Map([
          [yellowKey, 4],
          [whiteKey, 5],
        ]),
        serverLines: [
          serverYellow,
          line({
            listingId: "white",
            variantId: "white-v",
            quantity: 1,
            serverLineId: "row-white",
            price: 500,
          }),
        ],
        stamp: {
          revs: new Map([
            [yellowKey, 4],
            [whiteKey, 5],
          ]),
          identity: new Map(),
        },
        scope: { key: yellowKey, sinceRev: 4 },
      }),
    );

    const yellow = merged.lines.find((entry) => entry.listingId === "yellow");
    const white = merged.lines.find((entry) => entry.listingId === "white");
    expect(yellow).toMatchObject({
      serverLineId: "row-yellow",
      quantity: 1,
      swapRule: "store_suggests",
      price: 699,
      name: "Yellow Garri",
      packLabel: "1 lb",
    });
    expect(white?.quantity).toBe(2);
    expect(merged.pendingDelete.has(yellowKey)).toBe(false);
    expect(merged.confirmed.get(whiteKey)).toEqual({ lineId: "row-white", qty: 1 });
  });

  it("keeps a delete hidden until the failed write's revision is recovered", () => {
    const serverYellow = line({
      listingId: "yellow",
      variantId: "yellow-v",
      quantity: 1,
      serverLineId: "row-yellow",
    });
    const hidden = mergeServerLines(
      base({
        pendingDelete: new Map([[yellowKey, "row-yellow"]]),
        serverLines: [serverYellow],
        mode: "keep-intent",
      }),
    );
    expect(hidden.lines).toHaveLength(0);
    expect(hidden.pendingDelete.get(yellowKey)).toBe("row-yellow");
  });

  it("a newer gesture on the rejected line is kept with the other line's intent", () => {
    const merged = mergeServerLines(
      base({
        lines: [
          line({ listingId: "yellow", variantId: "yellow-v", quantity: 1, serverLineId: "row-yellow" }),
          line({ listingId: "white", variantId: "white-v", quantity: 2, serverLineId: "row-white" }),
        ],
        confirmed: new Map([
          [yellowKey, { lineId: "row-yellow", qty: 3 }],
          [whiteKey, { lineId: "row-white", qty: 1 }],
        ]),
        revs: new Map([
          [yellowKey, 9],
          [whiteKey, 8],
        ]),
        serverLines: [
          line({ listingId: "yellow", variantId: "yellow-v", quantity: 3, serverLineId: "row-yellow" }),
          line({ listingId: "white", variantId: "white-v", quantity: 1, serverLineId: "row-white" }),
        ],
        stamp: { revs: new Map([[yellowKey, 9], [whiteKey, 8]]), identity: new Map() },
        scope: { key: yellowKey, sinceRev: 7 },
      }),
    );
    expect(merged.lines.find((entry) => entry.listingId === "yellow")?.quantity).toBe(1);
    expect(merged.lines.find((entry) => entry.listingId === "white")?.quantity).toBe(2);
  });

  it("authoritative empty recovery clears the old row identity", () => {
    const cleared = clearKeyIdentity(
      {
        lines: [],
        confirmed: new Map([[yellowKey, { lineId: "row-yellow", qty: 1 }]]),
        pendingDelete: new Map([[yellowKey, "row-yellow"]]),
        dropAfterAdd: new Set(),
      },
      new Map([[yellowKey, 3]]),
      yellowKey,
      3,
    );
    expect(cleared?.confirmed.get(yellowKey)).toEqual({ qty: 0 });
    expect(cleared?.pendingDelete.has(yellowKey)).toBe(false);

    const kept = clearKeyIdentity(
      {
        lines: [line({ listingId: "yellow", variantId: "yellow-v", quantity: 2 })],
        confirmed: new Map([[yellowKey, { lineId: "row-yellow", qty: 1 }]]),
        pendingDelete: new Map([[yellowKey, "row-yellow"]]),
        dropAfterAdd: new Set(),
      },
      new Map([[yellowKey, 6]]),
      yellowKey,
      3,
    );
    expect(kept).toBeNull();

    const absent = mergeServerLines(
      base({
        lines: [],
        confirmed: new Map([[yellowKey, { lineId: "row-yellow", qty: 1 }]]),
        pendingDelete: new Map([[yellowKey, "row-yellow"]]),
        revs: new Map([[yellowKey, 2]]),
        serverLines: [],
        scope: { key: yellowKey, sinceRev: 2 },
      }),
    );
    expect(absent.lines).toHaveLength(0);
    expect(absent.confirmed.get(yellowKey)).toEqual({ qty: 0 });
    expect(absent.pendingDelete.has(yellowKey)).toBe(false);
  });

  it("uses the confirmed quantity rather than a queued quantity", () => {
    const snap = confirmedSnapshot(
      line({
        listingId: "yellow",
        variantId: "yellow-v",
        quantity: 4,
        serverLineId: "row-yellow",
        swapRule: "named_substitute",
        substituteVariantId: "white-v",
        price: 699,
      }),
      2,
    );
    expect(snap.quantity).toBe(2);
    expect(snap.serverLineId).toBe("row-yellow");
    expect(snap.swapRule).toBe("named_substitute");
    expect(snap.substituteVariantId).toBe("white-v");
  });

  it("prefers the live server row, including a changed price, over the local line", () => {
    const merged = mergeServerLines(
      base({
        lines: [
          line({
            listingId: "yellow",
            variantId: "yellow-v",
            quantity: 1,
            serverLineId: "row-yellow",
            price: 699,
            swapRule: "exact_only",
            substituteVariantId: null,
          }),
        ],
        confirmed: new Map([[yellowKey, { lineId: "row-yellow", qty: 1 }]]),
        pendingDelete: new Map([[yellowKey, "row-yellow"]]),
        revs: new Map([[yellowKey, 2]]),
        serverLines: [
          line({
            listingId: "yellow",
            variantId: "yellow-v",
            quantity: 4,
            serverLineId: "row-yellow",
            price: 750,
            swapRule: "named_substitute",
            substituteVariantId: "white-v",
            name: "Yellow Garri",
          }),
        ],
        scope: { key: yellowKey, sinceRev: 2 },
      }),
    );
    expect(merged.lines[0]).toMatchObject({
      quantity: 4,
      price: 750,
      swapRule: "named_substitute",
      substituteVariantId: "white-v",
      serverLineId: "row-yellow",
    });
  });

  it("full-cart server-wins still drops an optimistic line the server does not have", () => {
    const merged = mergeServerLines(
      base({
        lines: [line({ listingId: "white", variantId: "white-v", quantity: 1 })],
        mode: "server-wins",
        serverLines: [],
      }),
    );
    expect(merged.lines).toHaveLength(0);
  });

  it("keeps another line's optimistic first add during scoped recovery", () => {
    const merged = mergeServerLines(
      base({
        lines: [line({ listingId: "white", variantId: "white-v", quantity: 1, serverLineId: undefined })],
        revs: new Map([[yellowKey, 2]]),
        serverLines: [],
        scope: { key: yellowKey, sinceRev: 2 },
      }),
    );
    expect(merged.lines.map((entry) => entry.listingId)).toEqual(["white"]);
  });
});
