"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  approveApplicationAction,
  rejectApplicationAction,
  type DecisionState,
} from "@/lib/store-application/admin-actions";
import { REJECT_REASON_MAX } from "@/lib/store-application/fields";

const IDLE: DecisionState = { status: "idle" };

const input =
  "w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function Outcome({ state, id }: { state: DecisionState; id: string }) {
  if (state.status === "idle") return null;
  if (state.status === "error") {
    return <p id={id} role="alert" className="text-sm text-destructive">{state.message}</p>;
  }
  return (
    <p id={id} role="status" className="text-sm text-foreground">
      {state.message}{" "}
      {state.storeId && (
        <Link href={`/admin/stores/${state.storeId}`} className="font-medium text-primary underline">
          Open the store
        </Link>
      )}
    </p>
  );
}

export function ApproveForm({ applicationId, suggestedSlug, domainSuffix }: { applicationId: string; suggestedSlug: string; domainSuffix: string | null }) {
  const [state, action, pending] = useActionState(approveApplicationAction, IDLE);
  const slugError = state.status === "error" && state.field === "slug";
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="applicationId" value={applicationId} />
      <label htmlFor={`slug-${applicationId}`} className="text-sm font-medium text-foreground">
        Store address
      </label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center rounded-md border border-input bg-card focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
          <input
            id={`slug-${applicationId}`}
            name="slug"
            defaultValue={suggestedSlug}
            required
            maxLength={63}
            pattern="[a-z0-9][a-z0-9\-]*[a-z0-9]|[a-z0-9]"
            aria-invalid={slugError || undefined}
            aria-describedby={`approve-${applicationId}-outcome`}
            className="min-w-0 flex-1 bg-transparent px-3 py-2 font-mono text-sm text-foreground focus-visible:outline-none"
          />
          {domainSuffix && <span className="shrink-0 pr-3 text-sm text-muted-foreground">.{domainSuffix}</span>}
        </div>
        <button
          type="submit"
          disabled={pending || state.status === "done"}
          className="min-h-10 rounded-full bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {pending ? "Approving…" : "Approve"}
        </button>
      </div>
      <Outcome state={state} id={`approve-${applicationId}-outcome`} />
    </form>
  );
}

export function RejectForm({ applicationId }: { applicationId: string }) {
  const [state, action, pending] = useActionState(rejectApplicationAction, IDLE);
  return (
    <details className="group">
      <summary className="inline-flex min-h-10 cursor-pointer items-center rounded-full border border-input px-4 text-sm font-medium text-foreground hover:bg-muted">
        Reject…
      </summary>
      <form action={action} className="mt-3 flex flex-col gap-2">
        <input type="hidden" name="applicationId" value={applicationId} />
        <label htmlFor={`reason-${applicationId}`} className="text-sm font-medium text-foreground">
          Reason (internal; the applicant never sees it)
        </label>
        <textarea
          id={`reason-${applicationId}`}
          name="reason"
          required
          rows={3}
          maxLength={REJECT_REASON_MAX}
          className={input}
        />
        <button
          type="submit"
          disabled={pending || state.status === "done"}
          className="min-h-10 w-fit rounded-full border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
        >
          {pending ? "Rejecting…" : "Reject and email the applicant"}
        </button>
        <Outcome state={state} id={`reject-${applicationId}-outcome`} />
      </form>
    </details>
  );
}

/** A rejection whose plain email failed: the same action sends it once more. */
export function ResendRejectionForm({ applicationId }: { applicationId: string }) {
  const [state, action, pending] = useActionState(rejectApplicationAction, IDLE);
  return (
    <form action={action} className="flex flex-col items-start gap-1">
      <input type="hidden" name="applicationId" value={applicationId} />
      <input type="hidden" name="reason" value="" />
      <button
        type="submit"
        disabled={pending || state.status === "done"}
        className="text-sm font-medium text-primary underline disabled:opacity-50"
      >
        {pending ? "Sending…" : "Send email again"}
      </button>
      <Outcome state={state} id={`resend-${applicationId}-outcome`} />
    </form>
  );
}
