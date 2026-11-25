import { tool } from "ai";
import { z } from "zod";
import { platformAdmin } from "../../db";
import { isSlugRoutable } from "../../slug";
import { listAttributeProposals, listReviewProducts, type ReviewProduct } from "../catalog-actions";
import { listCategoryTree, type CategoryNode } from "../catalog-categories";
import { listDuplicatePairs } from "../catalog-duplicates";
import { languageLabel } from "../catalog-structure-form";
import { getMasterProductEditor, listMasterCatalog } from "../master-catalog";
import { listMetros } from "../metros";
import { timezoneForAddress } from "../timezone";
import { addDraft, refused } from "./draft-tools";
import type { DraftItem } from "./drafts";
import { BATCH_MAX } from "./workflow-kinds";
import { audited, link, type ToolContext } from "./tools";

const STORE_FIELDS = [
  ["name", "store name"],
  ["slug", "slug"],
  ["addressLine1", "street address"],
  ["city", "city"],
  ["state", "state"],
  ["zip", "ZIP"],
  ["ownerEmail", "owner email"],
  ["metro", "metro"],
] as const;

/** What keeps a review-queue product from being approved as it is. A clean product has none. */
export function reviewProblems(product: Pick<ReviewProduct, "categoryName" | "imageUrl" | "description" | "unit" | "weightG" | "confidence">): string[] {
  const problems: string[] = [];
  if (!product.categoryName) problems.push("no category");
  if (!product.imageUrl) problems.push("no photo");
  if (!product.description?.trim()) problems.push("no description");
  if (!product.unit && !product.weightG) problems.push("no size");
  if (product.confidence !== "high") problems.push(`${product.confidence ?? "unknown"} confidence`);
  return problems;
}

/** The review queue's pages read until enough products match; the queue can hold hundreds. */
async function reviewQueue(match: (product: ReviewProduct) => boolean): Promise<{ matched: ReviewProduct[]; more: boolean }> {
  const matched: ReviewProduct[] = [];
  for (let page = 1; page <= 50; page++) {
    const { products, total, pageSize } = await listReviewProducts({ status: "needs_review", page, pageSize: 100 });
    for (const product of products) {
      if (!match(product)) continue;
      if (matched.length === BATCH_MAX) return { matched, more: true };
      matched.push(product);
    }
    if (page * pageSize >= total) break;
  }
  return { matched, more: false };
}

/** A master product by its id or its exact name, through the catalogue screen's own search. */
async function findProduct(product: string): Promise<{ id: string; name: string } | null> {
  const byId = await getMasterProductEditor(product);
  if (byId) return { id: byId.product.id, name: byId.product.name };
  const wanted = product.trim().toLowerCase();
  const { products } = await listMasterCatalog({ q: product.trim().slice(0, 200) });
  const hit = products.find((row) => row.name.toLowerCase() === wanted && row.status !== "merged");
  return hit ? { id: hit.id, name: hit.name } : null;
}

function flatCategories(tree: CategoryNode[]): CategoryNode[] {
  return tree.flatMap((node) => [node, ...flatCategories(node.children)]);
}

const batchCard = (title: string, href: string, items: DraftItem[]) => ({
  title, storeName: null, changes: [], editable: null, warning: null, href, items,
});

/** The workflow tools (#833): each gathers what a manual job needs, checks it, then drafts one card for the whole job. */
export function workflowTools(ctx: ToolContext) {
  const { book } = ctx;
  return {
    draft_store_create: tool({
      description: "Draft creating a store as one workflow card: create the store, put it in its metro, invite the owner. Give every field you know; it lists what is still missing, and checks the slug is free. Ask the admin for anything missing; never make it up.",
      inputSchema: z.object({
        name: z.string().max(200).optional(),
        slug: z.string().max(80).optional(),
        addressLine1: z.string().max(120).optional(),
        city: z.string().max(80).optional(),
        state: z.string().max(2).optional(),
        zip: z.string().max(12).optional(),
        ownerEmail: z.string().max(320).optional(),
        metro: z.string().max(60).optional(),
      }),
      execute: (input) => audited(ctx, "draft_store_create", input, async () => {
        const value = Object.fromEntries(STORE_FIELDS.map(([key]) => [key, input[key]?.trim() ?? ""])) as Record<(typeof STORE_FIELDS)[number][0], string>;
        const missing = STORE_FIELDS.filter(([key]) => !value[key]).map(([, label]) => label);
        if (missing.length > 0) return { drafted: false, missing, reason: `Ask the admin for: ${missing.join(", ")}.` };

        const slug = value.slug.toLowerCase();
        const state = value.state.toUpperCase();
        const email = z.email().safeParse(value.ownerEmail.toLowerCase());
        if (!email.success) return refused("The owner email is not a valid email address.");
        if (!/^[A-Z]{2}$/.test(state)) return refused("The state must be a 2-letter code, such as TX.");
        if (!/^\d{5}$/.test(value.zip)) return refused("The ZIP must be 5 digits.");
        if (!isSlugRoutable(slug)) return refused("That slug is not allowed: use lowercase letters, numbers and hyphens, not a reserved word.");
        if (await platformAdmin.store.findUnique({ where: { slug }, select: { id: true } })) return refused("Another store already has that slug. Ask the admin for another.");
        const metros = await listMetros();
        const metro = metros.find((row) => row.name.toLowerCase() === value.metro.toLowerCase());
        if (!metro) return refused(`No metro has that name. Metros: ${metros.map((row) => row.name).join(", ") || "none"}.`);

        const timezone = timezoneForAddress(state, null, null);
        const address = `${value.addressLine1}, ${value.city}, ${state} ${value.zip}`;
        link(book, "Stores", "/admin/stores");
        return addDraft(ctx, "store_create", null, {
          name: value.name, slug, addressLine1: value.addressLine1, city: value.city, state, zip: value.zip, timezone, metroId: metro.id, ownerEmail: email.data,
        }, {
          title: "Create a store",
          storeName: value.name,
          changes: [
            { field: "Slug", from: "Free", to: slug },
            { field: "Address", from: "None", to: address },
            { field: "Timezone", from: "None", to: timezone },
          ],
          editable: null,
          warning: `Emails an owner invite to ${email.data}. This cannot be unsent.`,
          href: "/admin/stores",
          steps: ["Create the store", `Put it in the ${metro.name} metro`, `Invite the owner, ${email.data}`],
        });
      }),
    }),

    draft_review_approve: tool({
      description: `Draft approving products waiting in the catalogue review queue, at most ${BATCH_MAX} per card. By default only clean products (category, photo, description, size and high confidence); onlyClean false lists every product with its problems. Narrow by category name or productIds.`,
      inputSchema: z.object({
        onlyClean: z.boolean().optional(),
        category: z.string().max(60).optional(),
        productIds: z.array(z.string().min(1).max(200)).max(BATCH_MAX).optional(),
      }),
      execute: (input) => audited(ctx, "draft_review_approve", input, async () => {
        const onlyClean = input.onlyClean ?? true;
        const category = input.category?.trim().toLowerCase();
        const { matched, more } = await reviewQueue((product) =>
          (!input.productIds || input.productIds.includes(product.id))
          && (!category || product.categoryName?.toLowerCase() === category)
          && (!onlyClean || reviewProblems(product).length === 0));
        if (matched.length === 0) return refused(onlyClean ? "No clean product is waiting in the review queue." : "No product matching that is waiting in the review queue.");
        link(book, "Catalog review", "/admin/catalog/review");
        const items = matched.map((product) => ({ key: product.id, label: product.name, problems: reviewProblems(product) }));
        return {
          ...(await addDraft(ctx, "review_approve", null, { items: items.map(({ key, label }) => ({ key, label })) }, batchCard("Approve products in the review queue", "/admin/catalog/review", items))),
          ...(more ? { more: `More products match; this card holds the first ${BATCH_MAX}.` } : {}),
        };
      }),
    }),

    draft_attribute_approve: tool({
      description: `Draft approving pending attribute proposals (ingredients, allergens, dietary claims read from the label), at most ${BATCH_MAX} per card. Narrow by productIds.`,
      inputSchema: z.object({ productIds: z.array(z.string().min(1).max(200)).max(BATCH_MAX).optional() }),
      execute: (input) => audited(ctx, "draft_attribute_approve", input, async () => {
        const proposals = (await listAttributeProposals()).filter((row) => !input.productIds || input.productIds.includes(row.productId)).slice(0, BATCH_MAX);
        if (proposals.length === 0) return refused("No attribute proposal is waiting.");
        link(book, "Catalog review", "/admin/catalog/review");
        const items = proposals.map((row) => ({
          key: row.id,
          label: row.productName,
          problems: [row.ingredients, row.allergens, row.dietaryClaims].every((group) => group === null) ? ["nothing readable on the label"] : [],
        }));
        return addDraft(ctx, "attribute_approve", null, { items: items.map(({ key, label }) => ({ key, label })) }, batchCard("Approve attribute proposals", "/admin/catalog/review", items));
      }),
    }),

    draft_synonyms: tool({
      description: `Draft adding search synonyms to master products (another name shoppers use, with an optional ISO 639 language code such as yo, ig, ha, tw), at most ${BATCH_MAX} per card. product is the product's id or exact name.`,
      inputSchema: z.object({
        synonyms: z.array(z.object({
          product: z.string().min(1).max(200),
          term: z.string().min(1).max(100),
          language: z.string().max(3).optional(),
        })).min(1).max(BATCH_MAX),
      }),
      execute: (input) => audited(ctx, "draft_synonyms", input, async () => {
        const rows = [];
        for (const [index, row] of input.synonyms.entries()) {
          const product = await findProduct(row.product);
          if (!product) return refused(`No master product is called ${row.product}. Find it first.`);
          const term = row.term.trim().replace(/\s+/g, " ");
          const language = row.language?.trim().toLowerCase() ?? "";
          const label = `"${term}"${language ? ` in ${languageLabel(language)}` : ""} for ${product.name}`;
          rows.push({ key: String(index), label, productId: product.id, term, language });
        }
        link(book, "Catalog", "/admin/catalog/products");
        return addDraft(ctx, "synonym_add", null, { items: rows }, batchCard("Add synonyms", "/admin/catalog/products", rows.map(({ key, label }) => ({ key, label, problems: [] }))));
      }),
    }),

    draft_duplicate_merge: tool({
      description: `Draft merging open duplicate pairs from the duplicate scan, at most ${BATCH_MAX} per card. For each pair give the pairId and the product to keep; the other's listings and synonyms move to it. Without merges, it lists the pairs judged the same.`,
      inputSchema: z.object({
        merges: z.array(z.object({ pairId: z.string().min(1).max(200), keepProductId: z.string().min(1).max(200) })).max(BATCH_MAX).optional(),
      }),
      execute: (input) => audited(ctx, "draft_duplicate_merge", input, async () => {
        const pairs = await listDuplicatePairs();
        if (!input.merges?.length) {
          return {
            drafted: false,
            reason: "Say which product to keep in each pair, then draft again.",
            pairs: pairs.filter((pair) => pair.verdict === "same").slice(0, BATCH_MAX).map((pair) => ({
              pairId: pair.id,
              a: { id: pair.a.id, name: pair.a.name, listings: pair.a.stores.reduce((sum, row) => sum + row.listings, 0) },
              b: { id: pair.b.id, name: pair.b.name, listings: pair.b.stores.reduce((sum, row) => sum + row.listings, 0) },
              reason: pair.verdictReason,
            })),
          };
        }
        const rows = [];
        for (const merge of input.merges) {
          const pair = pairs.find((row) => row.id === merge.pairId);
          if (!pair) return refused(`Pair ${merge.pairId} is not open any more.`);
          const [keep, lose] = merge.keepProductId === pair.a.id ? [pair.a, pair.b] : merge.keepProductId === pair.b.id ? [pair.b, pair.a] : [null, null];
          if (!keep || !lose) return refused(`The product to keep must be one of the pair ${pair.a.name} / ${pair.b.name}.`);
          rows.push({ key: pair.id, label: `Keep ${keep.name}, merge ${lose.name} into it`, survivorId: keep.id });
        }
        link(book, "Duplicates", "/admin/catalog/duplicates");
        return addDraft(ctx, "duplicate_merge", null, { items: rows }, {
          ...batchCard("Merge duplicate products", "/admin/catalog/duplicates", rows.map(({ key, label }) => ({ key, label, problems: [] }))),
          warning: "A merge cannot be undone: the merged product's listings and synonyms move for good.",
        });
      }),
    }),

    draft_category_changes: tool({
      description: `Draft category changes, at most ${BATCH_MAX} per card: create (name, optional parent), rename (category, new name) or move (category, parent; no parent moves it to the top level). Categories by their current name.`,
      inputSchema: z.object({
        changes: z.array(z.object({
          action: z.enum(["create", "rename", "move"]),
          category: z.string().max(60).optional(),
          name: z.string().max(60).optional(),
          parent: z.string().max(60).optional(),
        })).min(1).max(BATCH_MAX),
      }),
      execute: (input) => audited(ctx, "draft_category_changes", input, async () => {
        const all = flatCategories(await listCategoryTree());
        const byName = (name: string | undefined) => (name ? all.find((row) => row.name.toLowerCase() === name.trim().toLowerCase()) ?? null : null);
        const rows = [];
        for (const [index, change] of input.changes.entries()) {
          const parent = byName(change.parent);
          if (change.parent && !parent) return refused(`No category is called ${change.parent}.`);
          const name = change.name?.trim() ?? "";
          if (change.action === "create") {
            if (!name) return refused("Give the new category's name.");
            rows.push({ key: String(index), label: `Create ${name}${parent ? ` under ${parent.name}` : ""}`, action: change.action, categoryId: null, name, parentId: parent?.id ?? null });
            continue;
          }
          const category = byName(change.category);
          if (!category) return refused(`No category is called ${change.category ?? "that"}.`);
          if (change.action === "rename") {
            if (!name) return refused("Give the category's new name.");
            rows.push({ key: String(index), label: `Rename ${category.name} to ${name}`, action: change.action, categoryId: category.id, name, parentId: null });
          } else {
            rows.push({ key: String(index), label: `Move ${category.name} ${parent ? `under ${parent.name}` : "to the top level"}`, action: change.action, categoryId: category.id, name: null, parentId: parent?.id ?? null });
          }
        }
        link(book, "Categories", "/admin/catalog/categories");
        return addDraft(ctx, "category_change", null, { items: rows }, batchCard("Category changes", "/admin/catalog/categories", rows.map(({ key, label }) => ({ key, label, problems: [] }))));
      }),
    }),
  };
}
