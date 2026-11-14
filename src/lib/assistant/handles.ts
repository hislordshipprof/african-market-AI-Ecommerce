import type { Prisma } from "@prisma/client";
import { lockConversationRow, storeScoped, storeScopedTransaction } from "../db";

/**
 * Short item handles (#597). The model miscopies long ids that differ in a few characters, so it never
 * sees one: tool results show i3 (listing), v12 (variant) or c2 (cart line), and tool inputs take them back.
 * Each conversation row keeps its own map, so a handle never resolves in another conversation or store.
 */
type Kind = "i" | "v" | "c";
type Saved = Record<Kind, string[]>;

const KINDS: readonly Kind[] = ["i", "v", "c"];
const OUTPUT_KINDS: Record<string, Kind> = {
  listingId: "i",
  variantId: "v",
  substituteVariantId: "v",
  backupVariantId: "v",
  lineId: "c",
};
const INPUT_FIELDS = new Set(["listing_id", "listing_ids", "variant_id", "backup_variant_id", "substitute_variant_id", "line_id"]);
const HANDLE = /^([ivc])([1-9]\d{0,5})$/;

export type HandleResolution = { ok: true; input: unknown } | { ok: false; handles: string[] };

export interface ItemHandles {
  /** Gives every id under an output id key a handle, then shows each known id as its handle. */
  toModel(value: unknown): Promise<unknown>;
  /** Handles in the id fields of a tool input, as ids. Anything that is not a handle of this chat is refused. */
  resolve(input: unknown): Promise<HandleResolution>;
  /** The same input with known handles as ids and anything else left as it was, for the saved transcript. */
  toIds(input: unknown): Promise<unknown>;
}

function parseSaved(value: unknown): Saved {
  const row = value && typeof value === "object" ? value as Partial<Record<Kind, unknown>> : {};
  const list = (items: unknown) => Array.isArray(items) ? items.filter((item): item is string => typeof item === "string") : [];
  return { i: list(row.i), v: list(row.v), c: list(row.c) };
}

export function itemHandles(storeId: string, conversationId: string): ItemHandles {
  let saved: Promise<Saved> | null = null;
  const load = () => {
    saved ??= storeScoped(storeId).aiConversation
      .findUnique({ where: { id: conversationId }, select: { itemHandles: true } })
      .then((row) => parseSaved(row?.itemHandles));
    return saved;
  };

  const handleById = (map: Saved) => {
    const byId = new Map<string, string>();
    for (const kind of KINDS) map[kind].forEach((id, index) => { if (!byId.has(id)) byId.set(id, `${kind}${index + 1}`); });
    return byId;
  };

  const idOf = (map: Saved, handle: string): string | null => {
    const match = HANDLE.exec(handle);
    if (!match) return null;
    return map[match[1] as Kind][Number(match[2]) - 1] ?? null;
  };

  async function register(wanted: Array<[Kind, string]>): Promise<Saved> {
    const current = await load();
    const known = handleById(current);
    if (wanted.every(([, id]) => known.has(id))) return current;
    const next = await storeScopedTransaction(storeId, async (tx) => {
      await lockConversationRow(tx, conversationId);
      const row = await tx.aiConversation.findUnique({ where: { id: conversationId }, select: { itemHandles: true } });
      if (!row) throw new Error("Conversation not found for item handles.");
      const map = parseSaved(row.itemHandles);
      const byId = handleById(map);
      for (const [kind, id] of wanted) {
        if (byId.has(id)) continue;
        map[kind].push(id);
        byId.set(id, `${kind}${map[kind].length}`);
      }
      await tx.aiConversation.update({
        where: { id: conversationId },
        data: { itemHandles: map as unknown as Prisma.InputJsonValue },
      });
      return map;
    });
    saved = Promise.resolve(next);
    return next;
  }

  function mapInput(input: unknown, map: Saved, unknown: string[] | null): unknown {
    const walk = (value: unknown, field: string): unknown => {
      if (typeof value === "string" && INPUT_FIELDS.has(field)) {
        const id = idOf(map, value);
        if (id === null) unknown?.push(value);
        return id ?? value;
      }
      if (Array.isArray(value)) return value.map((item) => walk(item, field));
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walk(child, key)]));
    };
    return walk(input, "");
  }

  return {
    async toModel(value) {
      const wanted: Array<[Kind, string]> = [];
      const collect = (node: unknown, field: string) => {
        if (typeof node === "string" && OUTPUT_KINDS[field]) wanted.push([OUTPUT_KINDS[field], node]);
        else if (Array.isArray(node)) node.forEach((item) => collect(item, field));
        else if (node && typeof node === "object") for (const [key, child] of Object.entries(node)) collect(child, key);
      };
      collect(value, "");
      const byId = handleById(await register(wanted));
      const swap = (node: unknown): unknown => {
        if (typeof node === "string") return byId.get(node) ?? node;
        if (Array.isArray(node)) return node.map(swap);
        if (!node || typeof node !== "object") return node;
        return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, swap(child)]));
      };
      return swap(value);
    },
    async resolve(input) {
      const unknown: string[] = [];
      const resolved = mapInput(input, await load(), unknown);
      return unknown.length > 0 ? { ok: false, handles: [...new Set(unknown)] } : { ok: true, input: resolved };
    },
    async toIds(input) {
      return mapInput(input, await load(), null);
    },
  };
}
