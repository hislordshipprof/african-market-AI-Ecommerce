"use client";
import { useEffect, useState } from "react";
import type { FlowOrder, FlowServices } from "@/lib/customer-flow/contracts";
import { getOrderSwapRule } from "@/lib/customer-flow/rules";
import { Button } from "../primitives";
import { ProductImage } from "../product-image";
import {
  DemoNotice,
  FlowCard,
  FlowError,
  FlowHeading,
  FlowLoading,
} from "./common";
import { money, useDemoOrder, type OrderFlowProps } from "./order-flow";
import "./order-flow.css";

export function SubstitutionCards({
  order,
  services,
  onChange,
}: {
  order: FlowOrder;
  services: FlowServices;
  onChange: (order: FlowOrder) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);
  async function resolve(id: string, decision: "swap" | "refund") {
    setBusy(id);
    try {
      onChange(await services.substitutions.resolve(order.token, id, decision));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save your choice.");
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="of-stack">
      {order.substitutions.map((sub) => {
        const seconds = Math.max(
          0,
          Math.ceil((Date.parse(sub.expiresAt) - now) / 1000),
        );
        const rule = getOrderSwapRule(order.storeId, order.id, sub.lineKey);
        return (
          <FlowCard
            key={sub.id}
            title={
              sub.decision
                ? "Substitution resolved"
                : "A little change to your basket"
            }
          >
            <p>{sub.original.name} is unavailable. The store suggests:</p>
            <div className="of-swap">
              <div className="of-line">
                <div className="of-photo">
                  <ProductImage
                    src={sub.original.imageUrl}
                    name={sub.original.name}
                    sizes="64px"
                  />
                </div>
                <div>
                  <small>Original · {sub.original.quantity} items</small>
                  <strong>{sub.original.name}</strong>
                  <p>{money(sub.original.price * sub.original.quantity)}</p>
                </div>
              </div>
              <div className="of-line">
                <div className="of-photo">
                  <ProductImage
                    src={sub.proposed.imageUrl}
                    name={sub.proposed.name}
                    sizes="64px"
                  />
                </div>
                <div>
                  <small>Replace with · {sub.original.quantity} items</small>
                  <strong>{sub.proposed.name}</strong>
                  <p>{money(sub.proposed.price * sub.original.quantity)}</p>
                </div>
              </div>
            </div>
            <p>
              <strong>
                {sub.deltaCents > 0 ? "+" : ""}
                {money(sub.deltaCents)}
              </strong>{" "}
              difference for this line
              {sub.deltaCents > 0
                ? ". Choosing Swap approves this increase within your test payment hold."
                : "."}
            </p>
            {sub.decision ? (
              <p role="status">
                {sub.decision === "swap" ? "Swap accepted" : "Item refunded"}
                {sub.timedOut ? " automatically after the timer expired." : "."}
              </p>
            ) : (
              <>
                <p>
                  Respond within{" "}
                  <strong>
                    {Math.floor(seconds / 60)}:
                    {String(seconds % 60).padStart(2, "0")}
                  </strong>
                  . On timeout,{" "}
                  {rule.kind === "exact"
                    ? "your exact-item rule refunds this item"
                    : "your saved swap rule is applied within the payment hold"}
                  . Updates are checked every 5 seconds.
                </p>
                <div className="of-actions">
                  <Button
                    disabled={busy === sub.id || seconds === 0}
                    onClick={() => resolve(sub.id, "swap")}
                  >
                    Swap
                  </Button>
                  <Button
                    disabled={busy === sub.id || seconds === 0}
                    onClick={() => resolve(sub.id, "refund")}
                  >
                    Refund
                  </Button>
                </div>
              </>
            )}
          </FlowCard>
        );
      })}
      {error && <FlowError message={error} />}
    </div>
  );
}

export function SubstitutionFlow(props: OrderFlowProps) {
  const { order, services, setOrder, error, refresh } = useDemoOrder(props);
  return (
    <div className="of-wrap">
      <FlowHeading
        title="Your substitutions"
        backHref={`/order/${props.token}`}
        backLabel="Back to order"
      />
      <DemoNotice />
      {error ? (
        <FlowError message={error}>
          <Button onClick={refresh}>Try again</Button>
        </FlowError>
      ) : order === undefined ? (
        <FlowLoading />
      ) : !order ? (
        <FlowError message="No order found in this browser for this store." />
      ) : order.substitutions.length ? (
        <SubstitutionCards
          order={order}
          services={services!}
          onChange={setOrder}
        />
      ) : (
        <FlowCard title="Everything is looking good">
          <p>No substitutions need your attention.</p>
        </FlowCard>
      )}
    </div>
  );
}
