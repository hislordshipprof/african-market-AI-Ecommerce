import { z } from "zod";
import { platformAdminTransaction } from "../../db";
import { money } from "../../format";
import { FORCE_REASON_MAX, forceGoLive } from "../../go-live/service";
import { readGoLiveChecklist } from "../../go-live/checklist";
import { PLATFORM_REFUND_REASON_MAX } from "../../order/platform-refund";
import { deleteCategory } from "../catalog-categories";
import { platformRefundAction } from "../platform-refund-action";
import { deleteRecipe, getRecipeEditor } from "../recipe-base-admin";
import { resolveRefundFailed } from "../refund-resolution";
import type { Kind } from "./drafts";

const id = z.string().min(1).max(200);
export const REASON_MAX = 500;

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const orderStatus = async ({ orderId }: { orderId: string }) => ({
  status: (await platformAdminTransaction((tx) => tx.order.findUnique({ where: { id: orderId }, select: { status: true } })))?.status ?? null,
});

/**
 * Money and hard-to-undo changes (#834). Each card is one order, store, category or dish, never a batch or a workflow,
 * and the confirm is refused until the admin has typed a reason on the card; the reason goes into the confirm's audit row.
 */
export const MONEY_KINDS = {
  platform_refund: {
    params: z.strictObject({ orderId: id, amountCents: z.number().int().positive(), submissionId: z.uuid(), reason: z.string().max(PLATFORM_REFUND_REASON_MAX) }),
    editKey: "reason",
    reasonRequired: true,
    snapshot: orderStatus,
    apply: async (p) => {
      const result = await platformRefundAction(null, form({ orderId: p.orderId, amountDollars: (p.amountCents / 100).toFixed(2), reason: p.reason, submissionId: p.submissionId }));
      if (!result.ok) return result;
      return { ok: true, outcome: result.pending ? `A refund of ${money(result.amountCents)} is confirming with the bank.` : `${money(result.amountCents)} is refunded to the customer.` };
    },
  } satisfies Kind<{ orderId: string; amountCents: number; submissionId: string; reason: string }>,
  refund_resolve: {
    params: z.strictObject({ orderId: id, repaidCents: z.number().int().positive(), displayedOwedCents: z.number().int().nonnegative(), note: z.string().max(REASON_MAX) }),
    editKey: "note",
    reasonRequired: true,
    snapshot: orderStatus,
    apply: async (p) => {
      const result = await resolveRefundFailed(p.orderId, p.note, p.repaidCents, p.displayedOwedCents);
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, outcome: result.message ?? "The order is resolved and cancelled." };
    },
  } satisfies Kind<{ orderId: string; repaidCents: number; displayedOwedCents: number; note: string }>,
  force_go_live: {
    params: z.strictObject({ storeId: id, reason: z.string().max(FORCE_REASON_MAX) }),
    editKey: "reason",
    reasonRequired: true,
    snapshot: async (p) => {
      const checklist = await readGoLiveChecklist(p.storeId, new Date());
      return { status: checklist?.status ?? null, open: checklist?.items.filter((item) => !item.done).map((item) => item.key) ?? [] };
    },
    apply: async (p, actor) => forceGoLive(p.storeId, p.reason, actor, new Date()),
  } satisfies Kind<{ storeId: string; reason: string }>,
  category_removal: {
    params: z.strictObject({ categoryId: id, reason: z.string().max(REASON_MAX) }),
    editKey: "reason",
    reasonRequired: true,
    snapshot: async (p) => {
      const row = await platformAdminTransaction((tx) => tx.category.findUnique({ where: { id: p.categoryId }, select: { name: true, _count: { select: { masterProducts: true, children: true } } } }));
      return row ? { name: row.name, products: row._count.masterProducts, children: row._count.children } : { name: null };
    },
    apply: async (p) => {
      const result = await deleteCategory({}, form({ categoryId: p.categoryId }));
      return result.ok ? { ok: true } : { ok: false, error: result.message ?? "The category was not deleted." };
    },
  } satisfies Kind<{ categoryId: string; reason: string }>,
  recipe_removal: {
    params: z.strictObject({ recipeId: id, version: z.string().min(1).max(200), reason: z.string().max(REASON_MAX) }),
    editKey: "reason",
    reasonRequired: true,
    snapshot: async (p) => {
      const editor = await getRecipeEditor(p.recipeId);
      return { version: editor?.recipe.version ?? null };
    },
    apply: async (p) => {
      const result = await deleteRecipe({}, form({ recipeId: p.recipeId, version: p.version }));
      return result.ok ? { ok: true } : { ok: false, error: result.message ?? "The dish was not deleted." };
    },
  } satisfies Kind<{ recipeId: string; version: string; reason: string }>,
} as const;
