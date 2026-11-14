"use server";

import { z } from "zod";
import { requirePlatformAdmin } from "../admin/session";
import { parseInput, readFormFields } from "../security/parse-input";
import { REJECT_REASON_MAX } from "./fields";
import { approveStoreApplication, rejectStoreApplication } from "./service";

export type DecisionState =
  | { status: "idle" }
  | { status: "done"; message: string; storeId?: string }
  | { status: "error"; message: string; field?: "slug" };

const approveSchema = z.strictObject({
  applicationId: z.string().min(1).max(64),
  slug: z.string().max(80),
});

const rejectSchema = z.strictObject({
  applicationId: z.string().min(1).max(64),
  reason: z.string().max(REJECT_REASON_MAX + 200),
});

// No revalidate: the card stays to show the outcome (an invite email that failed must stay visible); a reload moves it.
export async function approveApplicationAction(_previous: DecisionState, form: FormData): Promise<DecisionState> {
  const session = await requirePlatformAdmin();
  const parsed = parseInput(approveSchema, readFormFields(form, ["applicationId", "slug"]));
  if (!parsed.ok) return { status: "error", message: "Check the slug and try again." };

  const result = await approveStoreApplication(parsed.data.applicationId, parsed.data.slug, session.user);
  if (!result.ok) return { status: "error", message: result.error, field: result.field };
  return {
    status: "done",
    storeId: result.storeId,
    message: result.inviteEmailed
      ? "Store created in setup. The owner invite is on its way."
      : "Store created in setup, but the invite email did not send. Send it again from the store page.",
  };
}

export async function rejectApplicationAction(_previous: DecisionState, form: FormData): Promise<DecisionState> {
  const session = await requirePlatformAdmin();
  const parsed = parseInput(rejectSchema, readFormFields(form, ["applicationId", "reason"]));
  if (!parsed.ok) return { status: "error", message: `Keep the reason under ${REJECT_REASON_MAX} characters.` };

  const result = await rejectStoreApplication(parsed.data.applicationId, parsed.data.reason, session.user);
  if (!result.ok) return { status: "error", message: result.error };
  return {
    status: "done",
    message: result.emailed
      ? "Rejected. The applicant got a plain email without your reason."
      : "Rejected, but the email did not send. Reload the page and use Send email again.",
  };
}
