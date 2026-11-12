"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  approveAttributeProposal,
  rejectAttributeProposal,
  type AttributeProposalRow,
} from "@/lib/admin/catalog-actions";

function Group({ label, values }: { label: string; values: string[] | null }) {
  return (
    <div className="text-xs">
      <span className="font-medium text-[#15201A] dark:text-white">{label}: </span>
      <span className="text-[#55625A] dark:text-[#a0a8a3]">
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
      <p className="text-sm text-[#55625A] dark:text-[#a0a8a3]">
        No attributes waiting for review. Use Read attributes on a product to propose some.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {actionError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {actionError}
        </div>
      )}
      {proposals.map((proposal) => (
        <div
          key={proposal.id}
          className="flex flex-col gap-3 rounded-xl border border-[#e2e4e9] bg-white p-4 sm:flex-row sm:items-start dark:border-[#333] dark:bg-[#1a1a1a]"
        >
          {proposal.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={proposal.imageUrl} alt="" className="h-20 w-20 rounded-lg object-cover" />
          )}
          <div className="flex-1 space-y-1">
            <p className="text-sm font-semibold text-[#15201A] dark:text-white">{proposal.productName}</p>
            <Group label="Ingredients" values={proposal.ingredients} />
            <Group label="Contains allergens" values={proposal.allergens} />
            <Group label="Dietary claims" values={proposal.dietaryClaims} />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => decide(approveAttributeProposal, proposal.id)}
              disabled={isPending}
              className="rounded-full bg-[#2E7D4F] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#246b40] disabled:opacity-50"
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => decide(rejectAttributeProposal, proposal.id)}
              disabled={isPending}
              className="rounded-full border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
            >
              Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
