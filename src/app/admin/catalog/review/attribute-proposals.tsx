"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert } from "lucide-react";
import {
  approveAttributeProposal,
  rejectAttributeProposal,
  type AttributeProposalRow,
} from "@/lib/admin/catalog-actions";

function Group({ label, values }: { label: string; values: string[] | null }) {
  return (
    <div className="text-xs">
      <span className="font-medium text-foreground">{label}: </span>
      <span className="text-muted-foreground">
        {values === null ? "unknown (could not read)" : values.length === 0 ? "none" : values.join(", ").replaceAll("_", " ")}
      </span>
    </div>
  );
}

export function AttributeProposals({ proposals }: { proposals: AttributeProposalRow[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);

  function decide(action: typeof approveAttributeProposal, proposalId: string) {
    setActionError(null);
    startTransition(async () => {
      const result = await action(proposalId);
      if (result.error) setActionError(result.error);
      else router.refresh();
    });
  }

  if (proposals.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No attributes waiting for review. Use Read attributes on a product to propose some.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {actionError && (
        <div role="alert" className="flex gap-2 rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {actionError}
        </div>
      )}
      {proposals.map((proposal) => (
        <div
          key={proposal.id}
          className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-start"
        >
          {proposal.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={proposal.imageUrl} alt="" className="h-20 w-20 rounded-lg object-cover" />
          )}
          <div className="flex-1 space-y-1">
            <p className="text-sm font-semibold text-foreground">{proposal.productName}</p>
            <Group label="Ingredients" values={proposal.ingredients} />
            <Group label="Contains allergens" values={proposal.allergens} />
            <Group label="Dietary claims" values={proposal.dietaryClaims} />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => decide(approveAttributeProposal, proposal.id)}
              disabled={isPending}
              className="rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => decide(rejectAttributeProposal, proposal.id)}
              disabled={isPending}
              className="rounded-full border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
