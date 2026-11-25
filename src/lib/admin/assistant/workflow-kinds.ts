import { z } from "zod";
import { platformAdminTransaction } from "../../db";
import { createStore, inviteStoreOwnerAction } from "../actions";
import { approveAttributeProposal, approveProduct } from "../catalog-actions";
import { createCategory, updateCategory } from "../catalog-categories";
import { mergeDuplicatePair } from "../catalog-duplicates";
import { addProductSynonym } from "../product-synonyms";
import { setStoreMetro } from "../metros";
import { VALID_US_TIMEZONES } from "../timezone";
import type { Kind } from "./drafts";

const id = z.string().min(1).max(200);

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

/** One workflow step's result: done, or the reason it stopped. */
type Step = { ok: true } | { ok: false; error: string };

/**
 * Runs the steps in order and stops at the first that fails. The first step failing changes nothing, so the card stays
 * open; a later one leaves what was done in place (deleting a store is never the assistant's), and the outcome says so.
 */
async function runSteps(steps: Array<{ done: string; run: () => Promise<Step> }>): Promise<{ ok: true; outcome: string } | { ok: false; error: string }> {
  const done: string[] = [];
  for (const [index, step] of steps.entries()) {
    const result = await step.run();
    if (!result.ok) {
      if (index === 0) return { ok: false, error: result.error };
      return { ok: true, outcome: `Step ${index + 1} did not run: ${result.error} Done: ${done.join(", ")}. Finish the rest on the admin screen.` };
    }
    done.push(step.done);
  }
  return { ok: true, outcome: `Done: ${done.join(", ")}.` };
}

/** At most this many items on one batch card. */
export const BATCH_MAX = 20;

/** Runs each ticked item through the admin's own function; one that fails does not stop the rest. */
async function runBatch<T extends { key: string; label: string }>(items: T[], run: (item: T) => Promise<Step>): Promise<{ ok: true; outcome: string } | { ok: false; error: string }> {
  const failed: string[] = [];
  for (const item of items) {
    const result = await run(item);
    if (!result.ok) failed.push(`${item.label}: ${result.error}`);
  }
  if (failed.length === items.length) return { ok: false, error: `Nothing was done. ${failed.join("; ")}` };
  const done = `Done ${items.length - failed.length} of ${items.length}.`;
  return { ok: true, outcome: failed.length ? `${done} Not done: ${failed.join("; ")}.` : done };
}

const item = <S extends z.ZodRawShape>(shape: S) => z.strictObject({ key: id, label: z.string().max(300), ...shape });
const batch = <S extends z.ZodRawShape>(shape: S) => z.strictObject({ items: z.array(item(shape)).min(1).max(BATCH_MAX) });
const step = (result: { success?: boolean; error?: string }): Step => (result.error ? { ok: false, error: result.error } : { ok: true });
const stateStep = (result: { ok?: boolean; message?: string; fieldErrors?: Record<string, string | undefined> }): Step =>
  result.ok ? { ok: true } : { ok: false, error: Object.values(result.fieldErrors ?? {}).find(Boolean) ?? result.message ?? "It could not be saved." };

const reviewParams = batch({});
const attributeParams = batch({});
const synonymParams = batch({ productId: id, term: z.string().max(100), language: z.string().max(10) });
const mergeParams = batch({ survivorId: id });
const categoryParams = batch({
  action: z.enum(["create", "rename", "move"]),
  categoryId: id.nullable(),
  name: z.string().max(60).nullable(),
  parentId: id.nullable(),
});

const storeCreateParams = z.strictObject({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(80),
  addressLine1: z.string().min(1).max(120),
  city: z.string().min(1).max(80),
  state: z.string().length(2),
  zip: z.string().max(12),
  timezone: z.enum(VALID_US_TIMEZONES),
  metroId: id,
  ownerEmail: z.email().max(320),
});

/** The draft kinds that run an admin's manual steps as one workflow, or one change per item of a batch (#833). */
export const WORKFLOW_KINDS = {
  store_create: {
    params: storeCreateParams,
    // createStore refuses a slug that was taken since the draft, before anything is written.
    snapshot: async () => ({}),
    apply: async (p, actor) => {
      let storeId = "";
      return runSteps([
        {
          done: "the store was created",
          run: async () => {
            const result = await createStore({}, form({
              name: p.name, slug: p.slug, addressLine1: p.addressLine1, city: p.city, state: p.state, zip: p.zip, timezone: p.timezone,
            }));
            if (!result.success || !result.storeId) return { ok: false, error: result.error ?? Object.values(result.fieldErrors ?? {})[0] ?? "The store could not be created." };
            storeId = result.storeId;
            return { ok: true };
          },
        },
        {
          done: "it is in its metro",
          run: async () => (await platformAdminTransaction((tx) => setStoreMetro(tx, actor, storeId, p.metroId)))
            ? { ok: true }
            : { ok: false, error: "That metro no longer exists." },
        },
        {
          done: `the owner invite went to ${p.ownerEmail}`,
          run: async () => {
            const result = await inviteStoreOwnerAction(form({ storeId, email: p.ownerEmail }));
            if ("error" in result && result.error) return { ok: false, error: result.error };
            if ("warning" in result && result.warning) return { ok: false, error: "The invite email did not send; copy the invite link on the store page." };
            return { ok: true };
          },
        },
      ]);
    },
  } satisfies Kind<z.infer<typeof storeCreateParams>>,
  // Each batch kind's admin function re-checks its item under a lock (status, pending, open pair, category exists), so
  // the card keeps no snapshot of its own and a changed item is reported as not done.
  review_approve: {
    params: reviewParams,
    snapshot: async () => ({}),
    apply: (p) => runBatch(p.items, async (row) => step(await approveProduct(row.key, "needs_review"))),
  } satisfies Kind<z.infer<typeof reviewParams>>,
  attribute_approve: {
    params: attributeParams,
    snapshot: async () => ({}),
    apply: (p) => runBatch(p.items, async (row) => step(await approveAttributeProposal(row.key))),
  } satisfies Kind<z.infer<typeof attributeParams>>,
  synonym_add: {
    params: synonymParams,
    snapshot: async () => ({}),
    apply: (p) => runBatch(p.items, async (row) => stateStep(await addProductSynonym({}, form({
      productId: row.productId, term: row.term, language: row.language, languageOther: "", region: "",
    })))),
  } satisfies Kind<z.infer<typeof synonymParams>>,
  duplicate_merge: {
    params: mergeParams,
    snapshot: async () => ({}),
    apply: (p) => runBatch(p.items, async (row) => stateStep(await mergeDuplicatePair({}, form({ pairId: row.key, survivorId: row.survivorId })))),
  } satisfies Kind<z.infer<typeof mergeParams>>,
  category_change: {
    params: categoryParams,
    snapshot: async () => ({}),
    apply: (p) => runBatch(p.items, async (row) => {
      if (row.action === "create") return stateStep(await createCategory({}, form({ name: row.name ?? "", localName: "", parentId: row.parentId ?? "" })));
      // Read at confirm, so a rename and a move of one category on the same card both keep the other's change.
      const current = await platformAdminTransaction((tx) => tx.category.findUnique({ where: { id: row.categoryId ?? "" } }));
      if (!current) return { ok: false, error: "Category not found" };
      return stateStep(await updateCategory({}, form({
        categoryId: current.id,
        name: row.action === "rename" ? row.name ?? "" : current.name,
        localName: current.localName ?? "",
        parentId: row.action === "move" ? row.parentId ?? "" : current.parentId ?? "",
      })));
    }),
  } satisfies Kind<z.infer<typeof categoryParams>>,
} as const;
