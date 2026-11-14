"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { money } from "@/lib/format";
import { approveIssueAction, declineIssueAction } from "@/lib/order/actions";
import type { IssueToReview } from "@/lib/order/issue-review";

const TYPE_LABEL: Record<string, string> = {
  missing: "Missing",
  damaged: "Damaged",
  wrong: "Wrong item",
  poor_freshness: "Not fresh",
};

type Mode = "idle" | "partial" | "decline";

function ProblemCard({ issue }: { issue: IssueToReview }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("idle");
  const [dollars, setDollars] = useState("");
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();

  function run(action: () => Promise<{ ok: boolean; error?: string }>, done: string) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        toast.error(result.error ?? "Something went wrong. Try again.");
        return;
      }
      toast.success(done);
      router.refresh();
    });
  }

  function submitPartial() {
    const cents = Math.round(Number(dollars) * 100);
    if (!Number.isFinite(cents) || cents < 1 || cents > issue.amountCents) {
      toast.error(`Enter an amount from $0.01 to ${money(issue.amountCents)}.`);
      return;
    }
    run(() => approveIssueAction(issue.id, cents), `Refund of ${money(cents)} sent`);
  }

  const fieldId = `issue-${issue.id}`;
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base font-bold tabular-nums">#{issue.orderNumber}</CardTitle>
          <Badge variant="destructive">{TYPE_LABEL[issue.type] ?? issue.type}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {issue.customerName} · reported {issue.createdAt.toLocaleString()}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-3">
          {issue.hasPhoto && (
            <a href={`/api/issue-photo/${issue.id}`} target="_blank" rel="noreferrer" className="shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element -- private, no-store photo route */}
              <img
                src={`/api/issue-photo/${issue.id}`}
                alt={`Customer's photo of the problem with order ${issue.orderNumber}`}
                className="size-24 rounded-xl border object-cover"
              />
            </a>
          )}
          <div className="min-w-0 flex-1 space-y-1">
            {issue.lines.map((line, index) => (
              <div key={index} className="flex justify-between gap-2 text-sm">
                <span className="min-w-0 truncate">
                  {line.qty} × {line.name} <span className="text-muted-foreground">{line.variant}</span>
                </span>
                <span className="tabular-nums">{money(line.cents)}</span>
              </div>
            ))}
            <div className="flex justify-between border-t pt-1 text-sm font-semibold">
              <span>Asked for</span>
              <span className="tabular-nums">{money(issue.amountCents)}</span>
            </div>
          </div>
        </div>
        {issue.note && <p className="whitespace-pre-line text-sm italic text-muted-foreground">“{issue.note}”</p>}

        {mode === "partial" && (
          <div className="space-y-1.5">
            <Label htmlFor={`${fieldId}-amount`}>Amount to refund ($)</Label>
            <div className="flex gap-2">
              <Input
                id={`${fieldId}-amount`}
                inputMode="decimal"
                value={dollars}
                onChange={(event) => setDollars(event.target.value)}
                placeholder={(issue.amountCents / 100).toFixed(2)}
              />
              <Button className="rounded-full" disabled={isPending} onClick={submitPartial}>
                Refund
              </Button>
            </div>
          </div>
        )}
        {mode === "decline" && (
          <div className="space-y-1.5">
            <Label htmlFor={`${fieldId}-reason`}>Why are you declining?</Label>
            <Textarea
              id={`${fieldId}-reason`}
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
            />
            <Button
              variant="destructive"
              className="w-full rounded-full"
              disabled={isPending || !reason.trim()}
              onClick={() => run(() => declineIssueAction(issue.id, reason), "Problem declined")}
            >
              Decline
            </Button>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            className="rounded-full"
            disabled={isPending}
            onClick={() => run(() => approveIssueAction(issue.id), `Refund of ${money(issue.amountCents)} sent`)}
          >
            <Check className="mr-2 size-4" /> Approve {money(issue.amountCents)}
          </Button>
          <Button variant="outline" className="rounded-full" disabled={isPending} onClick={() => setMode(mode === "partial" ? "idle" : "partial")}>
            Partial
          </Button>
          <Button variant="outline" className="rounded-full" disabled={isPending} onClick={() => setMode(mode === "decline" ? "idle" : "decline")}>
            <X className="mr-2 size-4" /> Decline
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** In-review customer reports. Any store member can approve, refund part, or decline. */
export function ProblemsToReview({ issues }: { issues: IssueToReview[] }) {
  if (issues.length === 0) return null;
  return (
    <section id="problems" aria-labelledby="problems-heading" className="mb-6 space-y-3">
      <h2 id="problems-heading" className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <AlertTriangle className="size-4 text-destructive" aria-hidden="true" />
        Problems to review
        <Badge variant="secondary">{issues.length}</Badge>
      </h2>
      {issues.map((issue) => (
        <ProblemCard key={issue.id} issue={issue} />
      ))}
    </section>
  );
}
