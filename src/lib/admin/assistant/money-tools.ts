import { tool } from "ai";
import { z } from "zod";
import { platformAdminTransaction } from "../../db";
import { money } from "../../format";
import { FORCE_REASON_MAX } from "../../go-live/service";
import { goLiveItemLabel, readGoLiveChecklist } from "../../go-live/checklist";
import { PLATFORM_REFUNDABLE_FROM } from "../../order/refund-requests";
import { PLATFORM_REFUND_REASON_MAX } from "../../order/platform-refund";
import { getRecipeEditor } from "../recipe-base-admin";
import { listRefundFailedOrders } from "../refund-resolution";
import { REASON_MAX } from "./money-kinds";
import { addDraft, refused } from "./draft-tools";
import { audited, link, type ToolContext } from "./tools";

const REASON_LABEL = "Reason (type it to confirm)";
const AMBIGUOUS_STORE = "More than one store matches that name; give its slug.";
const orderInput = {
  orderNumber: z.number().int().positive(),
  store: z.string().min(1).max(200).describe("The store's slug or its name, as the read tools give it"),
};

/**
 * The order by number in the store named by slug or by whole name (the read tools give the name). Store names are not
 * unique, so a name or slug that matches more than one store is refused rather than guessed.
 */
async function orderBy(number: number, store: string) {
  const wanted = store.trim().toLocaleLowerCase("en-US");
  return platformAdminTransaction(async (tx) => {
    const stores = await tx.store.findMany({ select: { id: true, slug: true, name: true } });
    const matches = stores.filter((row) => row.slug === wanted || row.name.toLocaleLowerCase("en-US") === wanted);
    if (matches.length > 1) return AMBIGUOUS_STORE;
    const [match] = matches;
    if (!match) return null;
    const order = await tx.order.findFirst({
      where: { number, storeId: match.id },
      select: { id: true, number: true, status: true, storeId: true, store: { select: { name: true, slug: true } } },
    });
    return order && { ...order, storeLabel: `${order.store.name} (${order.store.slug})` };
  });
}

/**
 * Money and hard-to-undo cards (#834). Each tool drafts one card for one record and leaves the reason empty: the admin
 * types it on the card, and the confirm is refused without it. The model never writes the reason.
 */
export function moneyTools(ctx: ToolContext) {
  const { book } = ctx;
  return {
    draft_platform_refund: tool({
      description: "Draft one refund to the customer, from the platform, for one delivered or completed order: its number, its store (slug or name) and the amount in dollars. One order per card. The admin types the reason on the card.",
      inputSchema: z.object({ ...orderInput, amountDollars: z.number().positive().max(100_000) }),
      execute: (input) => audited(ctx, "draft_platform_refund", input, async () => {
        const order = await orderBy(input.orderNumber, input.store);
        if (typeof order === "string") return refused(order);
        if (!order) return refused("No order with that number at that store.");
        if (!(PLATFORM_REFUNDABLE_FROM as readonly string[]).includes(order.status)) return refused("Only a delivered, completed or partly refunded order can be refunded.");
        const amountCents = Math.round(input.amountDollars * 100);
        const href = link(book, `Order ${order.number}, ${order.storeLabel}`, `/admin/orders/search/${order.id}`);
        return addDraft(ctx, "platform_refund", order.storeId, { orderId: order.id, amountCents, submissionId: crypto.randomUUID(), reason: "" }, {
          title: "Refund the customer",
          storeName: order.storeLabel,
          changes: [{ field: `Order ${order.number}`, from: "Not refunded", to: `${money(amountCents)} refunded to the customer's card` }],
          editable: { label: REASON_LABEL, text: "", max: PLATFORM_REFUND_REASON_MAX },
          warning: `Sends ${money(amountCents)} back to the customer's card. This cannot be undone.`,
          href,
        });
      }),
    }),

    draft_refund_resolve: tool({
      description: "Draft resolving one order whose refund failed, after the customer was repaid outside Stripe: its number, its store (slug or name), and the amount repaid in dollars (leave it out when the whole amount owed was repaid). The admin types the note on the card.",
      inputSchema: z.object({ ...orderInput, repaidDollars: z.number().positive().max(100_000).optional() }),
      execute: (input) => audited(ctx, "draft_refund_resolve", input, async () => {
        const order = await orderBy(input.orderNumber, input.store);
        if (typeof order === "string") return refused(order);
        const row = order ? (await listRefundFailedOrders()).find((failed) => failed.orderId === order.id) : null;
        if (!order || !row) return refused("That order's refund has not failed, or it is already resolved.");
        const repaidCents = input.repaidDollars ? Math.round(input.repaidDollars * 100) : row.owedCents;
        if (repaidCents < 1) return refused("Nothing is owed on that order.");
        const href = link(book, `Order ${order.number}, ${order.storeLabel}`, `/admin/orders/search/${order.id}`);
        return addDraft(ctx, "refund_resolve", order.storeId, { orderId: order.id, repaidCents, displayedOwedCents: row.owedCents, note: "" }, {
          title: "Resolve a failed refund",
          storeName: order.storeLabel,
          changes: [
            { field: `Order ${order.number}`, from: "Refund failed", to: "Cancelled, resolved by hand" },
            { field: "Repaid outside Stripe", from: `${money(row.owedCents)} owed`, to: money(repaidCents) },
          ],
          editable: { label: "Note (type it to confirm)", text: "", max: REASON_MAX },
          warning: "Closes the order as repaid. This cannot be undone here.",
          href,
        });
      }),
    }),

    draft_force_go_live: tool({
      description: "Draft putting one store in setup live with go-live checklist items still open, by its slug. The admin types the reason on the card.",
      inputSchema: z.object({ slug: z.string().min(1).max(100) }),
      execute: (input) => audited(ctx, "draft_force_go_live", input, async () => {
        const store = await platformAdminTransaction((tx) => tx.store.findUnique({ where: { slug: input.slug.trim().toLowerCase() }, select: { id: true, name: true } }));
        const checklist = store ? await readGoLiveChecklist(store.id, ctx.now) : null;
        if (!store || !checklist) return refused("No store with that slug.");
        if (checklist.status !== "setup") return refused(`That store is ${checklist.status}, not in setup.`);
        const open = checklist.items.filter((item) => !item.done);
        if (open.length === 0) return refused("Every go-live item is done; the owner can go live without forcing it.");
        const href = link(book, store.name, `/admin/stores/${store.id}`);
        return addDraft(ctx, "force_go_live", store.id, { storeId: store.id, reason: "" }, {
          title: "Force go-live",
          storeName: store.name,
          changes: [
            { field: "Status", from: "setup", to: "active" },
            ...open.map((item) => ({ field: "Still open", from: goLiveItemLabel(item.key, checklist.floor), to: "Skipped" })),
          ],
          editable: { label: REASON_LABEL, text: "", max: FORCE_REASON_MAX },
          warning: "Shoppers can order from the store with these items open.",
          href,
        });
      }),
    }),

    draft_category_removal: tool({
      description: "Draft deleting one catalogue category by its name. Only an empty category (no products, no subcategories) can be deleted. The admin types the reason on the card.",
      inputSchema: z.object({ name: z.string().min(1).max(100) }),
      execute: (input) => audited(ctx, "draft_category_removal", input, async () => {
        const wanted = input.name.trim().toLocaleLowerCase("en-US");
        const category = (await platformAdminTransaction((tx) => tx.category.findMany({ select: { id: true, name: true, _count: { select: { masterProducts: true, children: true } } } })))
          .find((row) => row.name.toLocaleLowerCase("en-US") === wanted);
        if (!category) return refused("No category with that name.");
        if (category._count.masterProducts > 0 || category._count.children > 0) return refused("That category still has products or subcategories. Move them first.");
        const href = link(book, "Categories", "/admin/catalog/categories");
        return addDraft(ctx, "category_removal", null, { categoryId: category.id, reason: "" }, {
          title: "Delete category",
          storeName: null,
          changes: [{ field: "Category", from: category.name, to: "Deleted" }],
          editable: { label: REASON_LABEL, text: "", max: REASON_MAX },
          warning: "The category is removed. This cannot be undone.",
          href,
        });
      }),
    }),

    draft_recipe_removal: tool({
      description: "Draft deleting one dish from the recipe base by its name. Only a dish that is not curated can be deleted. The admin types the reason on the card.",
      inputSchema: z.object({ name: z.string().min(1).max(200) }),
      execute: (input) => audited(ctx, "draft_recipe_removal", input, async () => {
        const wanted = input.name.trim().toLocaleLowerCase("en-US");
        const recipe = (await platformAdminTransaction((tx) => tx.recipe.findMany({ where: { origin: { not: "curated" } }, select: { id: true, name: true } })))
          .find((row) => row.name.toLocaleLowerCase("en-US") === wanted);
        const editor = recipe ? await getRecipeEditor(recipe.id) : null;
        if (!recipe || !editor) return refused("No dish with that name that is not curated. A curated dish cannot be deleted.");
        const href = link(book, recipe.name, `/admin/catalog/recipes/${recipe.id}`);
        return addDraft(ctx, "recipe_removal", null, { recipeId: recipe.id, version: editor.recipe.version, reason: "" }, {
          title: "Delete dish",
          storeName: null,
          changes: [{ field: "Dish", from: `${recipe.name} (${editor.recipe.ingredients.length} ingredients)`, to: "Deleted" }],
          editable: { label: REASON_LABEL, text: "", max: REASON_MAX },
          warning: "The dish is removed from the recipe base. This cannot be undone.",
          href,
        });
      }),
    }),
  };
}
