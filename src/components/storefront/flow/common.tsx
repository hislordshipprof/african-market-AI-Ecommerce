import Link from "next/link";
import {
  ArrowLeft,
  ArrowUpRight,
  MapPin,
  ShieldCheck,
  ShoppingBag,
  Info,
} from "lucide-react";
import type { ReactNode } from "react";
import type {
  CheckoutQuote,
  FlowAddress,
  Fulfillment,
} from "@/lib/customer-flow/contracts";
import { orderSummary } from "@/lib/checkout/summary";
import { PriceDisplay } from "../price-display";

export function FlowHeading({
  title,
  description,
  backHref,
  backLabel = "Back to shopping",
}: {
  title: string;
  description?: string;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <header className="flow-heading">
      {backHref && (
        <Link className="sf-text-link" href={backHref}>
          <ArrowLeft size={16} aria-hidden />
          {backLabel}
        </Link>
      )}
      <div className="flow-eyebrow">Your neighborhood, delivered</div>
      <h1>{title}</h1>
      {description && <p>{description}</p>}
    </header>
  );
}
export function FlowCard({
  title,
  children,
  className = "",
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`flow-card ${className}`}>
      {title && <h2>{title}</h2>}
      {children}
    </section>
  );
}
export function DemoNotice() {
  return (
    <aside className="flow-demo">
      <Info size={18} aria-hidden />
      <p>
        <strong>Explore the demo.</strong> Payments, messages, addresses and
        order updates are simulated in this browser. No order is sent and no
        card is charged.
      </p>
    </aside>
  );
}
export function ClosedFlow() {
  return (
    <div className="sf-container flow-page">
      <FlowHeading
        title="A little closer to home"
        description="Your neighborhood market is getting ready for online orders."
      />
      <div className="flow-closed">
        <span className="flow-success-mark">
          <ShoppingBag size={36} aria-hidden />
        </span>
        <h2>Checkout opens soon</h2>
        <p>
          Keep exploring the store. Checkout, order tracking and customer
          accounts will be available when online ordering launches.
        </p>
        <Link href="/" className="sf-button">
          Explore the store <ArrowUpRight size={18} aria-hidden />
        </Link>
      </div>
    </div>
  );
}
/** Checkout refused: the page's heading says why, with no payment form and a way back. */
export function CheckoutUnavailable({ message }: { message: string }) {
  return (
    <div className="sf-container flow-page">
      <div className="flow-closed">
        <h1>{message}</h1>
        <p>Anything in your basket stays there. You can keep browsing the store and order later.</p>
        <div className="flow-closed-actions">
          <Link href="/" className="sf-button">
            Explore the store
          </Link>
          <Link href="/cart" className="sf-text-link">
            Back to basket
          </Link>
        </div>
      </div>
    </div>
  );
}

/** Basket and checkout render the same server quote through this one component. */
export function QuoteLines({
  quote,
  fulfillment,
}: {
  quote: CheckoutQuote;
  fulfillment: Fulfillment;
}) {
  const view = orderSummary(quote, fulfillment);
  return (
    <>
      {view.lines.map((line) => (
        <FeeLine key={line.key} label={line.label} cents={line.cents} />
      ))}
      <FeeLine label="Estimated total" cents={view.totalCents} strong />
      <FeeLine label="Temporary swap buffer" cents={view.bufferCents} />
      <FeeLine label="Authorization hold" cents={view.holdCents} strong />
    </>
  );
}

export function FeeLine({
  label,
  cents,
  detail,
  strong = false,
}: {
  label: string;
  cents: number;
  detail?: string;
  strong?: boolean;
}) {
  return (
    <div className={`flow-fee ${strong ? "flow-fee-total" : ""}`}>
      <div>
        <span>{label}</span>
        {detail && <small>{detail}</small>}
      </div>
      <PriceDisplay cents={cents} />
    </div>
  );
}
export function AddressCard({
  address,
  title = "Your address",
}: {
  address: FlowAddress | string;
  title?: string;
}) {
  const text =
    typeof address === "string"
      ? address
      : `${address.street}, ${address.city}, ${address.state} ${address.zip}`;
  return (
    <div className="flow-address-card">
      <div
        className="flow-map"
        role="img"
        aria-label="Illustrative demo map, not a real location"
      >
        <span className="flow-map-road" />
        <MapPin size={28} aria-hidden />
        <small>Demo map</small>
      </div>
      <div>
        <strong>{title}</strong>
        <p>{text}</p>
      </div>
    </div>
  );
}
export function FlowError({
  title = "Let’s get this sorted",
  message,
  children,
}: {
  title?: string;
  message: string;
  children?: ReactNode;
}) {
  return (
    <div className="flow-error" role="alert">
      <ShieldCheck size={24} aria-hidden />
      <div>
        <h2>{title}</h2>
        <p>{message}</p>
        {children && <div className="flow-actions">{children}</div>}
      </div>
    </div>
  );
}
export function FlowLoading() {
  return (
    <div
      className="sf-container flow-page"
      role="status"
      aria-label="Loading your details"
    >
      <span className="sr-only">Loading your details</span>
      <div className="flow-skeleton-title skeleton" />
      <div className="flow-layout">
        <div className="flow-stack">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flow-skeleton-card skeleton" />
          ))}
        </div>
        <div className="flow-skeleton-card skeleton" />
      </div>
    </div>
  );
}
