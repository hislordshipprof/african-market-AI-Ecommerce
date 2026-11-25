import { tool } from "ai";
import { z } from "zod";
import { platformAdmin } from "../../db";
import { isSlugRoutable } from "../../slug";
import { listMetros } from "../metros";
import { timezoneForAddress } from "../timezone";
import { addDraft, refused } from "./draft-tools";
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
  };
}
