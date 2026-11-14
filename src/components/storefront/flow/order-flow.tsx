"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, MapPin, MessageCircle, PackageCheck } from "lucide-react";
import type {
  FlowCatalogItem,
  FlowOrder,
  FlowStore,
  OrderStatus,
} from "@/lib/customer-flow/contracts";
import { createDemoServices } from "@/lib/customer-flow/demo-adapters";
import { effectiveOrderLines } from "@/lib/customer-flow/rules";
import { SuccessMark } from "./feedback";
import { Button, EmptyState } from "../primitives";
import { Sheet } from "../sheet";
import { ProductImage } from "../product-image";
import {
  AddressCard,
  DemoNotice,
  FeeLine,
  FlowCard,
  FlowError,
  FlowHeading,
  FlowLoading,
} from "./common";
import { SubstitutionCards } from "./substitution-flow";
import "./order-flow.css";

export interface OrderFlowProps {
  token: string;
  settings: FlowStore;
  catalog: FlowCatalogItem[];
  enabled: boolean;
  confirmation?: boolean;
}
import { money } from "@/lib/format";
export { money };
export const statusLabel = (status: OrderStatus) =>
  ({
    AUTHORIZED: "Order placed",
    ACCEPTED: "Store accepted",
    PICKING: "Shopping your order",
    SUBSTITUTION_PENDING: "Your choice is needed",
    READY: "Packed and ready",
    AWAITING_PICKUP: "Ready for pickup",
    COURIER_ASSIGNED: "Driver assigned",
    PICKED_UP: "On the way",
    DELIVERED: "Delivered",
    COMPLETED: "Completed",
    CANCELLED: "Cancelled",
  })[status];

export function useDemoOrder({
  token,
  settings,
  catalog,
  enabled,
}: OrderFlowProps) {
  const services = useMemo(
    () => (enabled ? createDemoServices(settings, catalog, enabled) : null),
    [settings, catalog, enabled],
  );
  const [order, setOrder] = useState<FlowOrder | null | undefined>();
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    if (!services) return;
    try {
      setOrder(await services.tracking.get(token));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load order.");
    }
  }, [services, token]);
  useEffect(() => {
    let active = true;
    const poll = async () => {
      if (!services) return;
      try {
        const next = await services.tracking.get(token);
        if (active) {
          setOrder(next);
          setError("");
        }
      } catch (e) {
        if (active)
          setError(e instanceof Error ? e.message : "Unable to load order.");
      }
    };
    void poll();
    const timer = window.setInterval(poll, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [services, token]);
  return { order, setOrder, error, setError, services, refresh };
}

export function OrderFlow(props: OrderFlowProps) {
  const { order, setOrder, error, setError, services, refresh } =
    useDemoOrder(props);
  const [busy, setBusy] = useState(false);
  const [chat, setChat] = useState(false);
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);
  if (error && !order)
    return (
      <FlowError message={error}>
        <Button onClick={refresh}>Try again</Button>
      </FlowError>
    );
  if (order === undefined) return <FlowLoading />;
  if (!order)
    return (
      <EmptyState
        title="Order not found"
        description="This demo link only works in the browser and store where you placed the order."
      >
        <Link className="sf-button" href="/">
          Return to the store
        </Link>
      </EmptyState>
    );
  const pending = order.substitutions.some((s) => !s.decision);
  const finished = ["COMPLETED", "CANCELLED"].includes(order.status);
  const stages: OrderStatus[] =
    order.fulfillment === "pickup"
      ? [
          "AUTHORIZED",
          "ACCEPTED",
          "PICKING",
          "READY",
          "AWAITING_PICKUP",
          "COMPLETED",
        ]
      : [
          "AUTHORIZED",
          "ACCEPTED",
          "PICKING",
          "READY",
          "COURIER_ASSIGNED",
          "PICKED_UP",
          "DELIVERED",
          "COMPLETED",
        ];
  async function advance(status?: OrderStatus) {
    if (!services) return;
    setBusy(true);
    try {
      setOrder(await services.tracking.advance(props.token, status));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not advance order.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="of-wrap">
      <FlowHeading
        title={
          props.confirmation ? "You're all set." : pending ? "Substitution pending" : statusLabel(order.status)
        }
        description={`Order ${order.number} · ${order.storeName}`}
        backHref="/"
        backLabel="Keep shopping"
      />
      <DemoNotice />
      {props.confirmation && (
        <FlowCard>
          <div className="of-confirm">
            <SuccessMark />
            <h2>Order placed</h2>
          </div>
          <p>
            Your test payment hold is {money(order.quote.holdCents)}. The final
            amount is calculated after picking; unused buffer is released.
          </p>
          <p>
            {props.settings.closed
              ? `The store opens ${props.settings.opensAt}. Your order joins the queue then.`
              : "Next, the store accepts your order and starts picking."}
          </p>
          <div className="of-actions">
            <Link className="sf-button" href={`/order/${order.token}`}>
              Track order
            </Link>
            <Link className="sf-text-link" href="/account/sign-in">
              Create an account
            </Link>
          </div>
        </FlowCard>
      )}
      <div className="of-columns">
        <div className="of-stack">
          <FlowCard
            title={
              order.fulfillment === "pickup" ? "Your pickup" : "Your delivery"
            }
          >
            <p className="of-eta">{order.etaLabel}</p>
            <p>
              {order.slot === "asap"
                ? "As soon as your groceries are ready"
                : new Date(order.slot).toLocaleString("en-US", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
            </p>
            <p>
              Estimated preparation: {props.settings.prepTimeMinutes} minutes
              after store acceptance.
            </p>
            <AddressCard
              address={
                order.fulfillment === "pickup"
                  ? order.pickupAddress
                  : (order.address ?? order.pickupAddress)
              }
            />
            <p>
              {order.fulfillment === "pickup"
                ? "Bring your order number when collecting your groceries."
                : "Your ETA is simulated in this demo."}
            </p>
          </FlowCard>
          {pending && (
            <div className="of-stack">
              <Link
                className="sf-text-link"
                href={`/order/${order.token}/substitutions`}
              >
                Review substitutions
              </Link>
              <SubstitutionCards
                order={order}
                services={services!}
                onChange={setOrder}
              />
            </div>
          )}
          <FlowCard title="Order progress">
            {pending && <p className="flow-demo" role="status">Substitution pending · your shopper needs a choice before continuing.</p>}
            <ol className="of-timeline">
              {stages.map((stage) => {
                const event = order.events.find((e) => e.status === stage);
                return (
                  <li
                    key={stage}
                    aria-current={order.status === stage ? "step" : undefined}
                    className={event ? "" : "of-future"}
                  >
                    <span className="of-dot">
                      {event ? (
                        <Check size={14} aria-hidden />
                      ) : (
                        <span aria-hidden className="of-pending-dot" />
                      )}
                    </span>
                    <div>
                      <strong>{statusLabel(stage)}</strong>
                      {event && (
                        <small>
                          {new Date(event.at).toLocaleTimeString([], {
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </small>
                      )}
                      {event?.note && <p>{event.note}</p>}
                    </div>
                  </li>
                );
              })}
            </ol>
            {order.status === "CANCELLED" && (
              <p>
                Your order was cancelled. No further demo steps are available.
              </p>
            )}
            {!finished && (
              <div className="of-demo-control">
                <p>
                  Demo controls · advance the simulated store journey. Updates
                  are checked every 5 seconds.
                </p>
                <Button
                  onClick={() => void advance()}
                  disabled={busy || pending}
                >
                  {busy
                    ? "Updating…"
                    : pending
                      ? "Resolve the swap to continue"
                      : "Demo: advance order"}
                </Button>
                {["AUTHORIZED", "ACCEPTED"].includes(order.status) && (
                  <button
                    className="sf-text-link"
                    disabled={busy}
                    onClick={() => void advance("CANCELLED")}
                  >
                    Demo: cancel order
                  </button>
                )}
              </div>
            )}
          </FlowCard>
          {order.courier && (
            <FlowCard title="Meet your driver">
              <div className="of-driver">
                <MapPin aria-hidden />
                <div>
                  <strong>{order.courier.name}</strong>
                  <p>
                    {order.courier.provider} · {order.courier.etaLabel}
                  </p>
                </div>
              </div>
              <AddressCard
                address={order.address ?? order.pickupAddress}
                title="Simulated delivery destination"
              />
            </FlowCard>
          )}
          {((order.fulfillment !== "pickup" &&
            ["DELIVERED", "COMPLETED"].includes(order.status)) ||
            order.proof) && (
            <FlowCard title="Delivery confirmation">
              <PackageCheck aria-hidden />
              <div className="of-proof">
                <ProductImage
                  src={order.lines[0]?.imageUrl}
                  name="Sample listing photograph; not actual delivery proof"
                  sizes="320px"
                />
              </div>
              <p>Sample listing photograph, not actual delivery proof.</p>
              <p>{order.proof?.caption}</p>
              {order.proof?.pin && (
                <p>
                  Demo delivery PIN: <strong>{order.proof.pin}</strong>
                </p>
              )}
              <p>Sample proof only. No actual delivery took place.</p>
            </FlowCard>
          )}
          <div className="of-actions">
            <Button onClick={() => setChat(true)}>
              <MessageCircle size={18} aria-hidden />
              Message the store
            </Button>
            <Link
              className="sf-text-link"
              href={`/order/${order.token}/report`}
            >
              Report an issue
            </Link>
          </div>
        </div>
        <aside className="of-stack">
          <FlowCard title="Your groceries">
            {effectiveOrderLines(order).map((line, i) => (
              <div className="of-line" key={i}>
                <div className="of-photo">
                  <ProductImage
                    src={line.imageUrl}
                    name={line.name}
                    sizes="64px"
                  />
                </div>
                <div>
                  <strong>{line.name}</strong>
                  <small>
                    {line.quantity} × {money(line.price)} {line.packLabel}
                  </small>
                </div>
                <span>{money(line.price * line.quantity)}</span>
              </div>
            ))}
            {order.substitutions
              .filter((sub) => sub.decision === "refund")
              .map((sub) => (
                <p className="flow-note" key={sub.id}>
                  {sub.original.name} · refunded during picking
                </p>
              ))}
          </FlowCard>
          <FlowCard title="Payment summary">
            <FeeLine
              label="Original order total"
              cents={order.quote.totalCents}
            />
            <FeeLine label="Test payment hold" cents={order.quote.holdCents} />
            <FeeLine
              label={
                order.finalCents === undefined
                  ? "Estimated final amount"
                  : "Final amount"
              }
              cents={order.finalCents ?? order.quote.totalCents}
              strong
            />
            <p>
              Includes tax, fulfilment fees and tip. The hold includes{" "}
              {money(order.quote.bufferCents)} for approved changes. No real
              payment is taken.
            </p>
          </FlowCard>
        </aside>
      </div>
      {error && <FlowError message={error} />}
      <Sheet
        open={chat}
        onClose={() => setChat(false)}
        title={`Message ${order.storeName}`}
      >
        <p>
          Demo conversation. Messages stay on this screen and are never sent to
          the store.
        </p>
        <form
          className="of-stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (message.trim()) setSent(true);
          }}
        >
          <label htmlFor="order-message">Your message</label>
          <textarea
            id="order-message"
            value={message}
            maxLength={1000}
            onChange={(e) => {
              setMessage(e.target.value);
              setSent(false);
            }}
          />
          <Button disabled={!message.trim()}>Preview message</Button>
          {sent && <p role="status">Preview saved on this screen: {message}</p>}
        </form>
      </Sheet>
    </div>
  );
}

export const AccountOrderDetail = OrderFlow;
