"use server";

import { z } from "zod";
import { parseInput, readFormFields } from "../security/parse-input";
import { refundOrderAsPlatform, PLATFORM_REFUND_AMOUNT_INVALID, type PlatformRefundResult } from "../order/platform-refund";
import { parseRepaidDollars } from "./repaid-dollars";
import { requirePlatformAdmin } from "./session";

const FIELDS = ["orderId", "amountDollars", "reason", "submissionId"] as const;

/** The order detail's refund form (#538). Platform admins only; the submission id makes a resubmit refund once. */
export async function platformRefundAction(_prev: PlatformRefundResult | null, formData: FormData): Promise<PlatformRefundResult> {
  const session = await requirePlatformAdmin();
  const parsed = parseInput(z.strictObject({
    orderId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    amountDollars: z.string().max(40),
    reason: z.string().max(2_000),
    submissionId: z.uuid(),
  }), readFormFields(formData, FIELDS));
  if (!parsed.ok) return { ok: false, error: "The form was not valid. Reload the order and try again." };
  const amountCents = parseRepaidDollars(parsed.data.amountDollars);
  if (amountCents === null) return { ok: false, error: PLATFORM_REFUND_AMOUNT_INVALID };
  return refundOrderAsPlatform(
    parsed.data.orderId,
    { amountCents, reason: parsed.data.reason, submissionId: parsed.data.submissionId },
    { id: session.user.id, email: session.user.email },
  );
}
