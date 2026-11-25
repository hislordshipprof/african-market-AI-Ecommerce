import { z } from "zod";
import { platformAdminTransaction } from "../../db";
import { createStore, inviteStoreOwnerAction } from "../actions";
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
} as const;
