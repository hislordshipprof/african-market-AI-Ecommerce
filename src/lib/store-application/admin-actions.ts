"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requirePlatformAdmin } from "../admin/session";
import { parseInput, readFormFields } from "../security/parse-input";
import { REJECT_REASON_MAX } from "./fields";
import { approveStoreApplication, rejectStoreApplication } from "./service";

export type DecisionState =
  | { status: "idle" }
  | { status: "error"; message: string; field?: "slug" };

const approveSchema = z.strictObject({
  applicationId: z.string().min(1).max(64),
  slug: z.string().max(80),
});

const rejectSchema = z.strictObject({
  applicationId: z.string().min(1).max(64),
  reason: z.string().max(REJECT_REASON_MAX + 200),
});

export async function approveApplicationAction(_previous: DecisionState, form: FormData): Promise<DecisionState> {
  const session = await requirePlatformAdmin();
  const parsed = parseInput(approveSchema, readFormFields(form, ["applicationId", "slug"]));
  if (!parsed.ok) return { status: "error", message: "Check the slug and try again." };

  const result = await approveStoreApplication(parsed.data.applicationId, parsed.data.slug, session.user);
  if (!result.ok) return { status: "error", message: result.error, field: result.field };
  // The outcome travels in the URL: approving refreshes the list, and a failed invite email must stay on screen.
  redirect(`/admin/applications?decided=${encodeURIComponent(parsed.data.applicationId)}&email=${result.inviteEmailed ? "sent" : "failed"}`);
}

export async function rejectApplicationAction(_previous: DecisionState, form: FormData): Promise<DecisionState> {
  const session = await requirePlatformAdmin();
  const parsed = parseInput(rejectSchema, readFormFields(form, ["applicationId", "reason"]));
  if (!parsed.ok) return { status: "error", message: `Keep the reason under ${REJECT_REASON_MAX} characters.` };

  const result = await rejectStoreApplication(parsed.data.applicationId, parsed.data.reason, session.user);
  if (!result.ok) return { status: "error", message: result.error };
  redirect(`/admin/applications?decided=${encodeURIComponent(parsed.data.applicationId)}&email=${result.emailed ? "sent" : "failed"}`);
}
