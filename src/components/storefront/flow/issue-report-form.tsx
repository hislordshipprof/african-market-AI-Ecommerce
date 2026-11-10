"use client";

import Link from "next/link";
import { useActionState } from "react";
import { reportIssueAction, type ReportIssueResult } from "@/lib/order/issue-actions";
import { FlowCard, FlowError } from "./common";
import { Button } from "../primitives";
import "./order-flow.css";

export type ReportLine = { id: string; name: string; qtyPicked: number; unitPriceCents: number };

const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

export function IssueReportForm({ token, lines }: { token: string; lines: ReportLine[] }) {
  const [result, action, pending] = useActionState<ReportIssueResult, FormData>(reportIssueAction, null);
  if (result?.ok) {
    return (
      <FlowCard title={result.state === "auto_refunded" ? "Refund on its way" : "Sent to the store"}>
        <p role="status">
          {result.state === "auto_refunded"
            ? "We've refunded those items to your card. We'll email and text you when the refund is issued."
            : "The store will review your report and get back to you."}
        </p>
        <Link className="sf-button" href={`/order/${token}`}>Back to order</Link>
      </FlowCard>
    );
  }
  return (
    <form action={action} className="of-stack">
      <input type="hidden" name="token" value={token} />
      <FlowCard title="What went wrong?">
        <div className="of-form">
          <label htmlFor="issue-type">Problem</label>
          <select id="issue-type" name="type" defaultValue="missing">
            <option value="missing">Missing item</option>
            <option value="damaged">Damaged item</option>
            <option value="wrong">Wrong item</option>
            <option value="poor_freshness">Poor freshness</option>
          </select>
          <fieldset>
            <legend>Which items, and how many?</legend>
            {lines.map((line) => (
              <label className="of-check" key={line.id}>
                <span>{line.name} · {money(line.unitPriceCents)} each</span>
                <input
                  type="number"
                  name={`qty:${line.id}`}
                  min={0}
                  max={line.qtyPicked}
                  defaultValue={0}
                  inputMode="numeric"
                  aria-label={`How many ${line.name} had a problem, up to ${line.qtyPicked}`}
                />
              </label>
            ))}
          </fieldset>
          <label htmlFor="issue-note">Anything the store should know? (optional)</label>
          <textarea id="issue-note" name="note" maxLength={1000} />
          <label htmlFor="issue-photo">One photo of the problem</label>
          <input id="issue-photo" name="photo" type="file" required accept="image/jpeg,image/png,image/webp" />
        </div>
      </FlowCard>
      <FlowCard title="Your refund">
        <p>Small problems are refunded to your card right away. Larger ones go to the store to review.</p>
        <Button disabled={pending}>{pending ? "Sending…" : "Report the problem"}</Button>
      </FlowCard>
      {result && !result.ok && <FlowError message={result.error} />}
    </form>
  );
}
