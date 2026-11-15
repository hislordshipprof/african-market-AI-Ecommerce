"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { platformRefundAction } from "@/lib/admin/platform-refund-action";
import type { PlatformRefundResult } from "@/lib/order/platform-refund";
import { parseRepaidDollars } from "@/lib/admin/repaid-dollars";
import { money } from "@/lib/format";

const FIELD = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** One form per render: `submissionId` comes from the server, so a second click refunds nothing more. */
export function RefundForm({ orderId, submissionId, remainingCents }: { orderId: string; submissionId: string; remainingCents: number | null }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<PlatformRefundResult | null, FormData>(platformRefundAction, null);
  const [dollars, setDollars] = useState("");
  const [reason, setReason] = useState("");
  const cents = parseRepaidDollars(dollars);

  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  return (
    <form action={action} className="grid gap-3" data-testid="platform-refund-form">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="submissionId" value={submissionId} />
      <p className="text-sm text-muted-foreground">
        Comes out of the store&apos;s transfer, like any refund. The customer gets the refund message; the store sees it was the platform team.
      </p>
      <div className="grid gap-1">
        <label htmlFor="refund-amount" className="text-sm font-medium text-foreground">Amount</label>
        <input
          id="refund-amount"
          name="amountDollars"
          inputMode="decimal"
          autoComplete="off"
          required
          placeholder="0.00"
          aria-describedby="refund-amount-hint"
          value={dollars}
          onChange={(event) => setDollars(event.target.value)}
          className={`${FIELD} max-w-40 tabular-nums`}
        />
        <p id="refund-amount-hint" className="text-xs text-muted-foreground">
          {remainingCents === null ? "From $0.01 up to what is left on the payment." : `From $0.01 up to ${money(remainingCents)}, what is left on the payment.`}
        </p>
      </div>
      <div className="grid gap-1">
        <label htmlFor="refund-reason" className="text-sm font-medium text-foreground">Reason</label>
        <textarea
          id="refund-reason"
          name="reason"
          required
          maxLength={500}
          rows={3}
          aria-describedby="refund-reason-hint"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className={FIELD}
        />
        <p id="refund-reason-hint" className="text-xs text-muted-foreground tabular-nums">Kept in the audit log. {reason.length}/500</p>
      </div>
      <div role="status" aria-live="polite" className="text-sm">
        {state && !state.ok && <p className="text-destructive">{state.error}</p>}
        {state?.ok && (
          <p className="text-foreground">
            {money(state.amountCents)} {state.pending ? "refund is confirming with the bank." : "refunded."}
          </p>
        )}
      </div>
      <button
        type="submit"
        disabled={pending || !!state?.ok}
        className="inline-flex min-h-11 w-fit items-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {pending ? "Refunding…" : cents && cents > 0 ? `Refund ${money(cents)}` : "Refund"}
      </button>
    </form>
  );
}
