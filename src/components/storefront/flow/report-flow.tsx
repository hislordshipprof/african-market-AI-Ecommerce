"use client";
import Link from "next/link";
import Image from "next/image";
import { useState, useEffect, type FormEvent } from "react";
import type { IssueResult, IssueType } from "@/lib/customer-flow/contracts";
import { cartItemKey } from "@/lib/storefront/cart-store";
import {
  effectiveOrderLines,
  orderIssueRefundCents,
} from "@/lib/customer-flow/rules";
import { Button } from "../primitives";
import {
  DemoNotice,
  FlowCard,
  FlowError,
  FlowHeading,
  FlowLoading,
} from "./common";
import { money, useDemoOrder, type OrderFlowProps } from "./order-flow";
import "./order-flow.css";

export function ReportFlow(props: OrderFlowProps) {
  const { order, services, error: loadError, refresh } = useDemoOrder(props);
  const [type, setType] = useState<IssueType>("missing");
  const [selected, setSelected] = useState<string[]>([]);
  const [description, setDescription] = useState("");
  const [photo, setPhoto] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<IssueResult>();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);
  const withinWindow =
    !!order?.completedAt && now - Date.parse(order.completedAt) <= 48 * 3600000;
  const reportableLines = order ? effectiveOrderLines(order) : [];
  const refund = order ? orderIssueRefundCents(order, selected) : 0;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!services || !withinWindow) return;
    setBusy(true);
    setError("");
    try {
      setResult(
        await services.issues.submit({
          token: props.token,
          type,
          lineKeys: selected,
          description,
          photo,
        }),
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to submit your report.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="of-wrap">
      <FlowHeading
        title="Let's make it right"
        description="Tell us what happened with your groceries."
        backHref={`/order/${props.token}`}
        backLabel="Back to order"
      />
      <DemoNotice />
      {loadError ? (
        <FlowError message={loadError}>
          <Button onClick={refresh}>Try again</Button>
        </FlowError>
      ) : order === undefined ? (
        <FlowLoading />
      ) : !order ? (
        <FlowError message="Order not found in this browser for this store." />
      ) : result ? (
        <FlowCard
          title={
            result.needsReview
              ? "Sent for store review"
              : "Demo refund recorded"
          }
        >
          <p role="status">
            {result.needsReview
              ? `The store will review your ${money(result.refundCents)} refund request.`
              : `${money(result.refundCents)} was recorded as a simulated refund.`}{" "}
            No actual money is moved.
          </p>
          <p>Reference {result.id}</p>
          <Link className="sf-button" href={`/order/${props.token}`}>
            Back to order
          </Link>
        </FlowCard>
      ) : !withinWindow ? (
        <FlowCard title="Reporting is unavailable">
          <p>
            Report issues within 48 hours after your order is completed.{" "}
            {order.completedAt
              ? "This order is outside that window."
              : "Your order has not been completed yet."}
          </p>
        </FlowCard>
      ) : (
        <form onSubmit={submit} className="of-stack">
          <FlowCard title="What went wrong?">
            <div className="of-form">
              <label htmlFor="issue-type">Issue type</label>
              <select
                id="issue-type"
                value={type}
                onChange={(e) => setType(e.target.value as IssueType)}
              >
                <option value="missing">Missing item</option>
                <option value="wrong">Wrong item</option>
                <option value="damaged">Damaged item</option>
                <option value="quality">Poor freshness or quality</option>
                <option value="other">Other</option>
              </select>
              <fieldset>
                <legend>Affected items</legend>
                {reportableLines.map((line) => {
                  const key = cartItemKey(line);
                  return (
                    <label className="of-check" key={key}>
                      <input
                        type="checkbox"
                        checked={selected.includes(key)}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...selected, key]
                              : selected.filter((k) => k !== key),
                          )
                        }
                      />
                      <span>
                        {line.quantity} × {line.name}
                      </span>
                      <strong>{money(line.price * line.quantity)}</strong>
                    </label>
                  );
                })}
              </fieldset>
              <label htmlFor="issue-description">Describe the issue</label>
              <textarea
                id="issue-description"
                required
                maxLength={2000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What should the store know?"
              />
              <label htmlFor="issue-photo">
                Photo (optional, maximum 5 MB)
              </label>
              <input
                id="issue-photo"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) => {
                  setPhoto(undefined);
                  setError("");
                  const file = e.target.files?.[0];
                  if (!file) return;
                  if (
                    file.size > 5 * 1024 * 1024 ||
                    !["image/jpeg", "image/png", "image/webp"].includes(
                      file.type,
                    )
                  ) {
                    setError("Choose a JPG, PNG or WebP photo up to 5 MB.");
                    e.target.value = "";
                    return;
                  }
                  const reader = new FileReader();
                  reader.onload = () => setPhoto(String(reader.result));
                  reader.onerror = () =>
                    setError("The photo could not be read. Try another image.");
                  reader.readAsDataURL(file);
                }}
              />
              {photo && (
                <div>
                  <Image
                    unoptimized
                    width={240}
                    height={220}
                    className="of-preview"
                    src={photo}
                    alt="Your issue photo preview"
                  />
                  <Button type="button" onClick={() => setPhoto(undefined)}>
                    Remove photo
                  </Button>
                </div>
              )}
            </div>
          </FlowCard>
          <FlowCard title="Refund preview">
            <p className="of-eta">Refund of {money(refund)} to your card</p>
            <p>
              {refund > props.settings.autoRefundLimitCents
                ? "This amount requires store review."
                : "Within the store's automatic demo refund limit."}{" "}
              Final eligibility is checked when you submit.
            </p>
            <p>
              Available for 48 hours after completion. This report is saved only
              as a browser demo.
            </p>
            <Button disabled={busy || !selected.length || !description.trim()}>
              {busy ? "Submitting…" : "Submit demo report"}
            </Button>
          </FlowCard>
          {error && <FlowError message={error} />}
        </form>
      )}
    </div>
  );
}
