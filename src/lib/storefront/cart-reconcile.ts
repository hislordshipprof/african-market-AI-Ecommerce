import { cartItemKey, type CartLine } from "@/lib/storefront/cart-store";

export type ConfirmedLine = { lineId?: string; qty: number };
export type ReconcileStamp = { revs: Map<string, number>; identity: Map<string, number> };
export type ReconcileScope = { key: string; sinceRev: number };
export type ReconcileMode = "keep-intent" | "server-wins";

export type ReconcileState = {
  lines: readonly CartLine[];
  confirmed: ReadonlyMap<string, ConfirmedLine>;
  pendingDelete: ReadonlyMap<string, string>;
  dropAfterAdd: ReadonlySet<string>;
};

export type MergeInput = ReconcileState & {
  revs: ReadonlyMap<string, number>;
  identity: ReadonlyMap<string, number>;
  serverLines: readonly CartLine[];
  stamp: ReconcileStamp;
  mode: ReconcileMode;
  /** Server-wins for one key. Every other key keeps its outstanding intent. */
  scope?: ReconcileScope;
};

export type MergeResult = {
  lines: CartLine[];
  confirmed: Map<string, ConfirmedLine>;
  pendingDelete: Map<string, string>;
  dropAfterAdd: Set<string>;
};

/**
 * A removal the server answered. `CART_NOT_FOUND` means the row is already
 * gone. Any other code, including `USER_NOT_FOUND`, still has to reconcile.
 */
export function removalResultAction(code: string | null): "committed" | "rejected" {
  if (code === null || code === "CART_NOT_FOUND") return "committed";
  return "rejected";
}

/** Last saved quantity, not an unsent optimistic target. */
export function confirmedSnapshot(line: CartLine, confirmedQty: number): CartLine {
  const quantity = confirmedQty > 0 ? confirmedQty : line.quantity;
  return { ...line, quantity };
}

function copyState(state: ReconcileState): MergeResult {
  return {
    lines: [...state.lines],
    confirmed: new Map(state.confirmed),
    pendingDelete: new Map(state.pendingDelete),
    dropAfterAdd: new Set(state.dropAfterAdd),
  };
}

/**
 * No cart, or a cart that no longer holds this key. Clears the old row id
 * so the next gesture cannot update or remove a row the server does not have.
 * A newer gesture on this key is left alone.
 */
export function clearKeyIdentity(
  state: ReconcileState,
  revs: ReadonlyMap<string, number>,
  key: string,
  sinceRev: number,
): MergeResult | null {
  if ((revs.get(key) ?? 0) > sinceRev) return null;
  const next = copyState(state);
  next.confirmed.set(key, { qty: 0 });
  next.pendingDelete.delete(key);
  next.dropAfterAdd.delete(key);
  next.lines = next.lines.filter((line) => cartItemKey(line) !== key);
  return next;
}

export function mergeServerLines(input: MergeInput): MergeResult {
  const confirmed = new Map(input.confirmed);
  const pendingDelete = new Map(input.pendingDelete);
  const dropAfterAdd = new Set(input.dropAfterAdd);
  const next: CartLine[] = [];
  const seen = new Set<string>();
  const scope = input.scope;

  const newerThanScope = (key: string) =>
    !!scope && scope.key === key && (input.revs.get(key) ?? 0) > scope.sinceRev;

  for (const server of input.serverLines) {
    const key = cartItemKey(server);
    seen.add(key);
    const local = input.lines.find((line) => cartItemKey(line) === key);
    const stampMoved = (input.revs.get(key) ?? 0) > (input.stamp.revs.get(key) ?? 0);
    const moved = scope?.key === key ? newerThanScope(key) : stampMoved;
    const identityMoved =
      (input.identity.get(key) ?? 0) > (input.stamp.identity.get(key) ?? 0);
    const acked = confirmed.get(key)?.qty ?? 0;
    const outstanding = !!local && local.quantity !== acked;
    confirmed.set(key, { lineId: server.serverLineId, qty: server.quantity });
    const scopedWins = scope?.key === key && !newerThanScope(key);
    if (!local) {
      if (scopedWins) {
        pendingDelete.delete(key);
        dropAfterAdd.delete(key);
        next.push(server);
        continue;
      }
      if (moved || pendingDelete.has(key) || dropAfterAdd.has(key)) {
        if (server.serverLineId) pendingDelete.set(key, server.serverLineId);
        dropAfterAdd.delete(key);
        continue;
      }
      next.push(server);
      continue;
    }
    const lineMode: ReconcileMode = scope ? "keep-intent" : input.mode;
    const keepQty =
      !scopedWins &&
      (moved ||
        (lineMode === "keep-intent" && (outstanding || local.quantity > server.quantity)));
    next.push({
      ...server,
      quantity: keepQty ? local.quantity : server.quantity,
      swapRule: scopedWins ? server.swapRule : identityMoved ? local.swapRule : server.swapRule,
      substituteVariantId: scopedWins
        ? server.substituteVariantId
        : identityMoved
          ? local.substituteVariantId
          : server.substituteVariantId,
    });
    if (scopedWins) {
      pendingDelete.delete(key);
      dropAfterAdd.delete(key);
    }
  }

  for (const local of input.lines) {
    const key = cartItemKey(local);
    if (seen.has(key)) continue;
    const stampMoved = (input.revs.get(key) ?? 0) > (input.stamp.revs.get(key) ?? 0);
    const moved = scope?.key === key ? newerThanScope(key) : stampMoved;
    const known = confirmed.get(key);
    const outstanding = local.quantity !== (known?.qty ?? 0);
    const optimistic = !known?.lineId && local.quantity > 0;
    const scopedWins = scope?.key === key && !newerThanScope(key);
    if (scopedWins) {
      confirmed.set(key, { qty: 0 });
      pendingDelete.delete(key);
      dropAfterAdd.delete(key);
      continue;
    }
    const lineMode: ReconcileMode = scope ? "keep-intent" : input.mode;
    if (moved || (lineMode === "keep-intent" && (outstanding || optimistic))) {
      // The server no longer has this row. A newer positive intent must be
      // saved as a new row; writing the old id again is rejected at the
      // current revision and the next recovery then drops the intent.
      if (moved && known?.lineId) {
        confirmed.set(key, { qty: 0 });
        if (pendingDelete.get(key) === known.lineId) pendingDelete.delete(key);
        next.push({ ...local, serverLineId: undefined });
        continue;
      }
      next.push(local);
      continue;
    }
    confirmed.set(key, { qty: 0 });
    pendingDelete.delete(key);
  }

  if (
    scope &&
    !seen.has(scope.key) &&
    !input.lines.some((line) => cartItemKey(line) === scope.key)
  ) {
    if (!newerThanScope(scope.key)) {
      confirmed.set(scope.key, { qty: 0 });
      pendingDelete.delete(scope.key);
      dropAfterAdd.delete(scope.key);
    }
  }

  return { lines: next, confirmed, pendingDelete, dropAfterAdd };
}
