"use client";

import Link from "next/link";
import { CircleAlert } from "lucide-react";
import type { CheckoutIssue, IssueSection } from "@/lib/checkout/checkout-issue";
import { Button } from "../primitives";
import styles from "./cart-checkout.module.css";

// Straight apostrophes, like the server messages shown under them (#743).
const TITLES: Record<IssueSection, string> = {
  payment: "Payment didn't go through",
  basket: "Your basket needs a change",
  session: "Your checkout needs a refresh",
  address: "We can't deliver there",
  network: "We couldn't reach the store",
  general: "Let's review that",
};

export interface IssueActions {
  useAnotherCard?: () => void;
  refresh?: () => void;
  retry?: () => void;
  editAddress?: () => void;
  choosePickup?: () => void;
}

/**
 * One checkout failure, shown beside the control it concerns, with the one
 * recovery that fixes it (#717 AC3). Focusable so the page can move focus here.
 */
export function CheckoutIssueAlert({ issue, id, actions }: { issue: CheckoutIssue; id: string; actions: IssueActions }) {
  const { section } = issue;
  return (
    <div className={styles.issue} role="alert" id={id} tabIndex={-1} data-issue={section}>
      <CircleAlert size={20} aria-hidden />
      <div>
        <p className={styles.issueTitle}>{TITLES[section]}</p>
        <p>{issue.message}</p>
        <div className={styles.issueActions}>
          {section === "payment" && actions.useAnotherCard && (
            <Button type="button" onClick={actions.useAnotherCard}>Use another card</Button>
          )}
          {section === "basket" && (
            <Link className="sf-button" href="/cart">Review basket</Link>
          )}
          {section === "session" && actions.refresh && (
            <Button type="button" onClick={actions.refresh}>Refresh checkout</Button>
          )}
          {section === "network" && actions.retry && (
            <Button type="button" onClick={actions.retry}>Try again</Button>
          )}
          {section === "address" && actions.editAddress && (
            <Button type="button" onClick={actions.editAddress}>Edit address</Button>
          )}
          {section === "address" && actions.choosePickup && (
            <Button type="button" onClick={actions.choosePickup}>Choose pickup</Button>
          )}
        </div>
      </div>
    </div>
  );
}
