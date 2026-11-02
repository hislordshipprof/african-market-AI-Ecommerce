"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { MapPin, ShoppingBag, Truck } from "lucide-react";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { useCart } from "../cart-provider";
import { Button, Chip, EmptyState } from "../primitives";
import { createDemoServices } from "@/lib/customer-flow/demo-adapters";
import { cartItemKey } from "@/lib/storefront/cart-store";
import { clearCart } from "@/lib/cart/actions";
import {
  quoteCheckoutAction,
  createPaymentIntentAction,
  placeOrderAction,
} from "@/lib/checkout/actions";
import type {
  CheckoutInput,
  CheckoutQuote,
  FlowAddress,
  Fulfillment,
} from "@/lib/customer-flow/contracts";
import {
  AddressCard,
  DemoNotice,
  FeeLine,
  FlowCard,
  FlowError,
  FlowHeading,
  FlowLoading,
} from "./common";
import { PayButton } from "./feedback";
import { money, useCartReady, type ShoppingFlowProps } from "./cart-page";
import styles from "./cart-checkout.module.css";

type Outcome =
  | "success"
  | "declined"
  | "out-of-stock"
  | "outside-radius"
  | "session-expired";

interface StripeConfig {
  publishableKey: string;
  accountId: string;
}

export interface CheckoutPageProps extends ShoppingFlowProps {
  stripeConfig?: StripeConfig;
}

let stripePromiseCache: Promise<StripeJs | null> | null = null;
function getStripePromise(config: StripeConfig): Promise<StripeJs | null> {
  if (!stripePromiseCache) {
    stripePromiseCache = loadStripe(config.publishableKey, {
      stripeAccount: config.accountId,
    });
  }
  return stripePromiseCache;
}

function StripeCardInput() {
  return (
    <div className={styles.stripeCard}>
      <PaymentElement
        options={{
          layout: "tabs",
          fields: { billingDetails: { address: "never" } },
        }}
      />
    </div>
  );
}

function RealCheckoutForm({
  settings,
  catalog,
  stripeConfig,
}: {
  settings: ShoppingFlowProps["settings"];
  catalog: ShoppingFlowProps["catalog"];
  stripeConfig: StripeConfig;
}) {
  const { lines, subtotal, refreshCart } = useCart();
  const router = useRouter();
  const stripe = useStripe();
  const elements = useElements();
  const [fulfillment, setFulfillment] = useState<Fulfillment>(
    settings.pickupEnabled
      ? "pickup"
      : settings.storeDeliveryEnabled
        ? "store-delivery"
        : "courier",
  );
  const [contact, setContact] = useState({ name: "", phone: "", email: "" });
  const [address, setAddress] = useState<FlowAddress>();
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<FlowAddress[]>([]);
  const [searching, setSearching] = useState(false);
  const [notes, setNotes] = useState("");
  const [leaveAtDoor, setLeaveAtDoor] = useState(false);
  const [schedule, setSchedule] = useState(false);
  const [slot, setSlot] = useState("asap");
  const [promo, setPromo] = useState("");
  const [appliedPromo, setAppliedPromo] = useState("");
  const [promoMessage, setPromoMessage] = useState("");
  const [tipPercent, setTipPercent] = useState<number | null>(15);
  const [customTip, setCustomTip] = useState("");
  const [quote, setQuote] = useState<CheckoutQuote | null>(null);
  const [quoteKey, setQuoteKey] = useState("");
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [payState, setPayState] = useState<"idle" | "pending" | "success">("idle");
  const metadata = lines.map((line) => ({
    line,
    item: catalog.find((item) => cartItemKey(item) === cartItemKey(line)),
  }));
  const frozen = metadata.some(({ item }) => item?.frozen);
  const weightG = metadata.reduce(
    (sum, { line, item }) => sum + (item?.weightG ?? 0) * line.quantity,
    0,
  );
  const courierEligible =
    weightG <= 22679.6 &&
    metadata.every(({ item }) => !!item && item.weightG <= 22679.6) &&
    (!frozen || settings.insulatedPackaging);
  const tipCents =
    tipPercent === null
      ? Math.max(0, Math.round((Number(customTip) || 0) * 100))
      : Math.round((subtotal * tipPercent) / 100);
  const input = useMemo<CheckoutInput>(
    () => ({
      lines,
      fulfillment,
      contact,
      address,
      notes,
      leaveAtDoor: frozen ? false : leaveAtDoor,
      slot: schedule && fulfillment === "pickup" ? slot : "asap",
      promoCode: appliedPromo,
      tipCents,
    }),
    [lines, fulfillment, contact, address, notes, frozen, leaveAtDoor, schedule, slot, appliedPromo, tipCents],
  );
  const currentKey = JSON.stringify(input);
  const quotePending = !quote || quoteKey !== currentKey;

  useEffect(() => {
    let active = true;
    quoteCheckoutAction(input).then((result) => {
      if (!active) return;
      if (result.ok) {
        setQuote(result.quote);
        setQuoteKey(JSON.stringify(input));
      } else {
        setError(result.error);
      }
    });
    return () => { active = false; };
  }, [input]);

  // Address search with demo lookup
  const demoServices = useMemo(
    () => {
      try { return createDemoServices(settings, catalog, true); } catch { return null; }
    },
    [settings, catalog],
  );
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      if (query.trim().length < 3 || !demoServices) { setSuggestions([]); return; }
      setSearching(true);
      demoServices.addresses.search(query)
        .then((results) => { if (active) setSuggestions(results); })
        .catch(() => { if (active) setError("Address lookup is unavailable."); })
        .finally(() => { if (active) setSearching(false); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [query, demoServices]);

  const [slots] = useState(() => {
    const first = new Date();
    first.setHours(10, 0, 0, 0);
    if (first.getTime() <= Date.now()) first.setDate(first.getDate() + 1);
    return Array.from({ length: 6 }, (_, i) => {
      const date = new Date(first);
      date.setDate(date.getDate() + i);
      return {
        value: date.toISOString(),
        label: date.toLocaleString("en-US", {
          weekday: "short", month: "short", day: "numeric", hour: "numeric",
        }),
      };
    });
  });

  async function pay(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    setError("");
    if (schedule && slot === "asap") {
      setError("Choose a pickup time within the next six days.");
      return;
    }
    if (payState !== "idle" || !stripe || !elements) return;
    setPayState("pending");
    try {
      const quoteResult = await quoteCheckoutAction(input);
      if (!quoteResult.ok) throw new Error(quoteResult.error);
      const latest = quoteResult.quote;
      if (latest.problems.length) {
        throw new Error(
          latest.problems
            .map((p) => p.message)
            .filter((v, i, a) => a.indexOf(v) === i)
            .join(" "),
        );
      }

      const piResult = await createPaymentIntentAction(latest.holdCents);
      if (!piResult.ok) throw new Error(piResult.error);

      const { error: submitError } = await elements.submit();
      if (submitError) throw new Error(submitError.message ?? "Card validation failed");

      const { error: confirmError } = await stripe.confirmPayment({
        elements,
        clientSecret: piResult.clientSecret,
        confirmParams: { return_url: window.location.href },
        redirect: "if_required",
      });
      if (confirmError) throw new Error(confirmError.message ?? "Payment failed");

      const orderResult = await placeOrderAction(
        piResult.paymentIntentId,
        input,
        latest,
      );
      if (!orderResult.ok) throw new Error(orderResult.error);

      setPayState("success");
      await clearCart();
      await refreshCart();
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches)
        await new Promise((r) => setTimeout(r, 650));
      router.push(`/order/${orderResult.token}?placed=1`);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "We could not place your order. Your basket is saved.",
      );
      setPayState("idle");
    }
  }

  return (
    <CheckoutLayout
      settings={settings}
      catalog={catalog}
      lines={lines}
      subtotal={subtotal}
      fulfillment={fulfillment}
      setFulfillment={setFulfillment}
      contact={contact}
      setContact={setContact}
      address={address}
      setAddress={setAddress}
      query={query}
      setQuery={setQuery}
      suggestions={suggestions}
      setSuggestions={setSuggestions}
      searching={searching}
      notes={notes}
      setNotes={setNotes}
      leaveAtDoor={leaveAtDoor}
      setLeaveAtDoor={setLeaveAtDoor}
      schedule={schedule}
      setSchedule={setSchedule}
      slot={slot}
      setSlot={setSlot}
      slots={slots}
      promo={promo}
      setPromo={setPromo}
      appliedPromo={appliedPromo}
      setAppliedPromo={setAppliedPromo}
      promoMessage={promoMessage}
      setPromoMessage={setPromoMessage}
      tipPercent={tipPercent}
      setTipPercent={setTipPercent}
      customTip={customTip}
      setCustomTip={setCustomTip}
      quote={quote}
      quotePending={quotePending}
      error={error}
      submitted={submitted}
      payState={payState}
      frozen={frozen}
      weightG={weightG}
      courierEligible={courierEligible}
      onSubmit={pay}
      paymentSection={<StripeCardInput />}
      payLabel={quote ? `Pay · ${money(quote.holdCents)}` : "Pay"}
      isRealPayment
    />
  );
}

export function CheckoutPage({
  settings,
  catalog,
  enabled,
  stripeConfig,
}: CheckoutPageProps) {
  const ready = useCartReady();
  const { lines } = useCart();

  if (!ready) return <FlowLoading />;
  if (!lines.length)
    return (
      <div className={styles.page}>
        <FlowHeading title="Checkout" />
        <EmptyState
          title="Your basket is waiting"
          description="Add your favorites before checking out."
        />
      </div>
    );

  if (stripeConfig?.publishableKey && !enabled) {
    return (
      <StripeWrapper config={stripeConfig}>
        <RealCheckoutForm settings={settings} catalog={catalog} stripeConfig={stripeConfig} />
      </StripeWrapper>
    );
  }

  return (
    <DemoCheckoutPage settings={settings} catalog={catalog} enabled={enabled} />
  );
}

function StripeWrapper({
  config,
  children,
}: {
  config: StripeConfig;
  children: React.ReactNode;
}) {
  const stripePromise = useMemo(() => getStripePromise(config), [config]);
  return (
    <Elements
      stripe={stripePromise}
      options={{
        mode: "payment",
        amount: 100,
        currency: "usd",
        appearance: {
          theme: "stripe",
          variables: { colorPrimary: "#16a34a" },
        },
      }}
    >
      {children}
    </Elements>
  );
}

/* ---------- Shared layout ---------- */

interface CheckoutLayoutProps {
  settings: ShoppingFlowProps["settings"];
  catalog: ShoppingFlowProps["catalog"];
  lines: ReturnType<typeof useCart>["lines"];
  subtotal: number;
  fulfillment: Fulfillment;
  setFulfillment: (f: Fulfillment) => void;
  contact: { name: string; phone: string; email: string };
  setContact: (c: { name: string; phone: string; email: string }) => void;
  address: FlowAddress | undefined;
  setAddress: (a: FlowAddress | undefined) => void;
  query: string;
  setQuery: (q: string) => void;
  suggestions: FlowAddress[];
  setSuggestions: (s: FlowAddress[]) => void;
  searching: boolean;
  notes: string;
  setNotes: (n: string) => void;
  leaveAtDoor: boolean;
  setLeaveAtDoor: (v: boolean) => void;
  schedule: boolean;
  setSchedule: (v: boolean) => void;
  slot: string;
  setSlot: (v: string) => void;
  slots: { value: string; label: string }[];
  promo: string;
  setPromo: (v: string) => void;
  appliedPromo: string;
  setAppliedPromo: (v: string) => void;
  promoMessage: string;
  setPromoMessage: (v: string) => void;
  tipPercent: number | null;
  setTipPercent: (v: number | null) => void;
  customTip: string;
  setCustomTip: (v: string) => void;
  quote: CheckoutQuote | null;
  quotePending: boolean;
  error: string;
  submitted: boolean;
  payState: "idle" | "pending" | "success";
  frozen: boolean;
  weightG: number;
  courierEligible: boolean;
  onSubmit: (e: FormEvent) => void;
  paymentSection: React.ReactNode;
  payLabel: string;
  isRealPayment: boolean;
  outcomeSelector?: React.ReactNode;
}

function CheckoutLayout(props: CheckoutLayoutProps) {
  const {
    settings, catalog, lines, fulfillment, setFulfillment,
    contact, setContact, address, setAddress, query, setQuery,
    suggestions, setSuggestions, searching, notes, setNotes,
    leaveAtDoor, setLeaveAtDoor, schedule, setSchedule,
    slot, setSlot, slots, promo, setPromo, appliedPromo,
    setAppliedPromo, promoMessage, setPromoMessage,
    tipPercent, setTipPercent, customTip, setCustomTip,
    quote, quotePending, error, submitted, payState,
    frozen, weightG, courierEligible,
    onSubmit, paymentSection, payLabel, isRealPayment, outcomeSelector,
  } = props;

  return (
    <div className={styles.page}>
      <FlowHeading
        title="A little closer to home"
        description="Review your order and choose how it reaches you."
        backHref="/cart"
        backLabel="Back to basket"
      />
      {!isRealPayment && <DemoNotice />}
      <nav className={styles.stages} aria-label="Checkout sections">
        <a href="#fulfillment">1. Fulfillment</a>
        <a href="#contact">2. Contact</a>
        <a href="#payment">3. Payment</a>
        <a href="#review">4. Review</a>
      </nav>
      <form className={styles.layout} onSubmit={onSubmit} noValidate>
        <fieldset className={styles.formFields} disabled={payState !== "idle"}>
          <legend className="sr-only">Checkout details</legend>
          <div id="fulfillment" className={styles.anchor}>
            <FlowCard title="How would you like your order?">
              <div className={styles.options}>
                <Chip
                  type="button"
                  selected={fulfillment === "pickup"}
                  disabled={!settings.pickupEnabled}
                  onClick={() => setFulfillment("pickup")}
                >
                  <ShoppingBag size={18} />
                  Pickup · Free
                </Chip>
                {settings.storeDeliveryEnabled && (
                  <Chip
                    type="button"
                    selected={fulfillment === "store-delivery"}
                    onClick={() => setFulfillment("store-delivery")}
                  >
                    <Truck size={18} />
                    Store delivery · {money(settings.storeDeliveryFeeCents)}
                  </Chip>
                )}
                <Chip
                  type="button"
                  selected={fulfillment === "courier"}
                  disabled={!courierEligible}
                  onClick={() => setFulfillment("courier")}
                >
                  <Truck size={18} />
                  Courier · {money(699)} {!isRealPayment && "demo quote"}
                </Chip>
              </div>
              <p className={styles.muted}>
                Order weight: {(weightG / 453.592).toFixed(1)} lb. Delivery
                radius: {settings.deliveryRadiusMi} miles.
              </p>
              {!courierEligible && (
                <p className={styles.error}>
                  Courier is unavailable: orders and individual items must be 50
                  lb or less; frozen goods also require confirmed insulated
                  packaging. Choose pickup or store delivery.
                </p>
              )}
              {frozen && (
                <p className={styles.notice}>
                  Frozen food needs a hand-to-hand delivery. Leave at door is
                  unavailable.
                </p>
              )}
              {fulfillment === "pickup" ? (
                <AddressCard
                  address={settings.address}
                  title="Collect from the market"
                />
              ) : (
                <>
                  <label className={styles.field}>
                    Delivery address
                    <input
                      autoComplete="street-address"
                      value={query}
                      onChange={(event) => {
                        setQuery(event.target.value);
                        setAddress(undefined);
                      }}
                      placeholder="Search a street address"
                    />
                  </label>
                  {searching && <p role="status">Finding addresses…</p>}
                  {!address &&
                    suggestions.map((result) => (
                      <button
                        type="button"
                        className={styles.addressResult}
                        key={result.id}
                        onClick={() => {
                          setAddress(result);
                          setSuggestions([]);
                        }}
                      >
                        <MapPin size={20} />
                        <span>
                          {result.street}
                          <small>
                            {result.city}, {result.state} {result.zip} ·{" "}
                            {result.distanceMi} mi
                          </small>
                        </span>
                      </button>
                    ))}
                  {address && <AddressCard address={address} title="Delivery to" />}
                  <label className={styles.check}>
                    <input
                      type="checkbox"
                      checked={!frozen && leaveAtDoor}
                      disabled={frozen}
                      onChange={(event) => setLeaveAtDoor(event.target.checked)}
                    />
                    Leave at door
                  </label>
                  <p className={styles.muted}>
                    If the courier cannot reach you due to an incorrect address
                    or an unanswered delivery, a return-to-store fee may apply.
                  </p>
                </>
              )}
            </FlowCard>
          </div>
          <FlowCard title="When works for you?">
            {settings.closed && (
              <p className={styles.notice}>
                The market is closed. Opens {settings.opensAt}. Order now to
                join the queue; estimated ready about {settings.prepTimeMinutes}{" "}
                minutes after opening.
              </p>
            )}
            <div className={styles.options}>
              <Chip
                type="button"
                selected={!schedule}
                onClick={() => setSchedule(false)}
              >
                {settings.closed
                  ? "When the store opens"
                  : `ASAP · about ${settings.prepTimeMinutes} min`}
              </Chip>
              {fulfillment === "pickup" && (
                <Chip
                  type="button"
                  selected={schedule}
                  onClick={() => { setSchedule(true); setSlot(slots[0].value); }}
                >
                  Schedule pickup
                </Chip>
              )}
            </div>
            {schedule && fulfillment === "pickup" && (
              <label className={styles.field}>
                Pickup time
                <select value={slot} onChange={(e) => setSlot(e.target.value)}>
                  {slots.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <small>Pickup is available within the next six days.</small>
              </label>
            )}
            <label className={styles.field}>
              Order notes (optional)
              <textarea
                value={notes}
                maxLength={1000}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Apartment, gate code, or a note for your shopper"
              />
            </label>
          </FlowCard>
          <div id="contact" className={styles.anchor}>
            <FlowCard title="Contact details">
              <p className={styles.muted}>
                Guest checkout. A phone number helps your shopper reach you
                about substitutions.
              </p>
              <label className={styles.field}>
                Full name
                <input
                  autoComplete="name"
                  required
                  value={contact.name}
                  aria-invalid={submitted && !contact.name.trim()}
                  onChange={(e) => setContact({ ...contact, name: e.target.value })}
                />
              </label>
              {submitted && !contact.name.trim() && (
                <p className={styles.error}>Enter the name for your order.</p>
              )}
              <label className={styles.field}>
                Phone number (required)
                <input
                  autoComplete="tel"
                  type="tel"
                  required
                  value={contact.phone}
                  onChange={(e) => setContact({ ...contact, phone: e.target.value })}
                  placeholder="(555) 123-4567"
                />
              </label>
              {submitted &&
                (!/^\+?[\d\s().-]{10,20}$/.test(contact.phone) ||
                  contact.phone.replace(/\D/g, "").length < 10) && (
                  <p className={styles.error}>
                    Enter a valid phone number with at least 10 digits.
                  </p>
                )}
              <label className={styles.field}>
                Email (required)
                <input
                  autoComplete="email"
                  type="email"
                  required
                  value={contact.email}
                  aria-invalid={submitted && !contact.email.trim()}
                  onChange={(e) => setContact({ ...contact, email: e.target.value })}
                />
              </label>
              {submitted && !contact.email.trim() && (
                <p className={styles.error}>Enter an email address.</p>
              )}
            </FlowCard>
          </div>
          <FlowCard title="A thank-you for your driver">
            <p className={styles.muted}>
              100% of your tip goes to the courier. Default is 15%; you can
              change it.
            </p>
            <div className={styles.options}>
              {[0, 10, 15, 20].map((value) => (
                <Chip
                  key={value}
                  type="button"
                  selected={tipPercent === value}
                  onClick={() => setTipPercent(value)}
                >
                  {value}%
                </Chip>
              ))}
              <Chip
                type="button"
                selected={tipPercent === null}
                onClick={() => setTipPercent(null)}
              >
                Custom
              </Chip>
            </div>
            {tipPercent === null && (
              <label className={styles.field}>
                Custom tip ($)
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={customTip}
                  onChange={(e) => setCustomTip(e.target.value)}
                />
              </label>
            )}
          </FlowCard>
          <div id="payment" className={styles.anchor}>
            <FlowCard title={isRealPayment ? "Payment" : "Test payment"}>
              {paymentSection}
              {outcomeSelector}
            </FlowCard>
          </div>
        </fieldset>
        <aside id="review" className={`${styles.sticky} ${styles.anchor}`}>
          <FlowCard title="Your order">
            <p className={styles.muted}>
              {settings.name} ·{" "}
              {lines.reduce((sum, l) => sum + l.quantity, 0)} items{" "}
              <Link className="sf-text-link" href="/cart">Edit basket</Link>
            </p>
            <ul className={styles.miniLines}>
              {lines.map((line) => (
                <li key={cartItemKey(line)}>
                  <span>{line.quantity} × {line.name}</span>
                  <span>{money(line.quantity * line.price)}</span>
                </li>
              ))}
            </ul>
            <label className={styles.field}>
              Promo code
              <div className={styles.inline}>
                <input
                  value={promo}
                  disabled={payState !== "idle"}
                  onChange={(e) => setPromo(e.target.value)}
                  placeholder="Try WELCOME10"
                />
                <Button
                  type="button"
                  disabled={payState !== "idle"}
                  onClick={() => {
                    const code = promo.trim().toUpperCase();
                    setAppliedPromo(code === "WELCOME10" ? code : "");
                    setPromoMessage(
                      code === "WELCOME10"
                        ? "10% off applied, up to $10."
                        : code
                          ? "That code is not valid."
                          : "Promo removed.",
                    );
                  }}
                >
                  Apply
                </Button>
              </div>
            </label>
            {promoMessage && (
              <p className={styles.muted} role="status">{promoMessage}</p>
            )}
            {quote ? (
              <>
                <FeeLine label="Subtotal" cents={quote.subtotalCents} />
                <FeeLine label="Store delivery" cents={quote.deliveryFeeCents} />
                <FeeLine
                  label={quote.courierProvider ? `${quote.courierProvider}` : "Courier"}
                  cents={quote.courierFeeCents}
                />
                <FeeLine label="Estimated tax" cents={quote.taxCents} />
                <FeeLine label="Tip" cents={quote.tipCents} />
                {!!quote.discountCents && (
                  <FeeLine label="Promo savings" cents={-quote.discountCents} />
                )}
                <FeeLine label="Estimated total" cents={quote.totalCents} strong />
                <FeeLine label="Temporary swap buffer" cents={quote.bufferCents} />
                <FeeLine label="Authorization hold" cents={quote.holdCents} strong />
              </>
            ) : (
              <p role="status">Estimating your order…</p>
            )}
            <p className={styles.notice}>
              {quote && (
                <>
                  Your card will be authorized for {money(quote.holdCents)}.
                  You&rsquo;ll be charged the final amount after picking.{" "}
                </>
              )}
              We authorize the estimated total plus a 10% buffer, capped at $20.
              You&rsquo;ll be charged the final amount after picking; unused
              funds are released. Any higher-priced swap requires your approval
              and must fit within this hold.
            </p>
            {quotePending && (
              <p className={styles.muted} role="status">Updating estimate…</p>
            )}
            {error && <FlowError title="Let's review that" message={error} />}
            <PayButton
              type="submit"
              state={payState}
              disabled={payState !== "idle" || quotePending}
              label={payLabel}
            />
            <p className={styles.muted}>
              By placing this order, you approve the authorization hold and
              your fulfillment choices.
            </p>
          </FlowCard>
        </aside>
      </form>
    </div>
  );
}

/* ---------- Demo fallback ---------- */

function DemoCheckoutPage({
  settings,
  catalog,
  enabled,
}: ShoppingFlowProps) {
  const { lines, subtotal, refreshCart } = useCart();
  const ready = useCartReady();
  const router = useRouter();
  const services = useMemo(
    () => createDemoServices(settings, catalog, enabled),
    [settings, catalog, enabled],
  );
  const [fulfillment, setFulfillment] = useState<Fulfillment>(
    settings.pickupEnabled
      ? "pickup"
      : settings.storeDeliveryEnabled
        ? "store-delivery"
        : "courier",
  );
  const [contact, setContact] = useState({ name: "", phone: "", email: "" });
  const [address, setAddress] = useState<FlowAddress>();
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<FlowAddress[]>([]);
  const [searching, setSearching] = useState(false);
  const [notes, setNotes] = useState("");
  const [leaveAtDoor, setLeaveAtDoor] = useState(false);
  const [schedule, setSchedule] = useState(false);
  const [slot, setSlot] = useState("asap");
  const [promo, setPromo] = useState("");
  const [appliedPromo, setAppliedPromo] = useState("");
  const [promoMessage, setPromoMessage] = useState("");
  const [tipPercent, setTipPercent] = useState<number | null>(15);
  const [customTip, setCustomTip] = useState("");
  const [quote, setQuote] = useState<CheckoutQuote | null>(null);
  const [quoteKey, setQuoteKey] = useState("");
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [payState, setPayState] = useState<"idle" | "pending" | "success">("idle");
  const [outcome, setOutcome] = useState<Outcome>("success");
  const metadata = lines.map((line) => ({
    line,
    item: catalog.find((item) => cartItemKey(item) === cartItemKey(line)),
  }));
  const frozen = metadata.some(({ item }) => item?.frozen);
  const weightG = metadata.reduce(
    (sum, { line, item }) => sum + (item?.weightG ?? 0) * line.quantity,
    0,
  );
  const courierEligible =
    weightG <= 22679.6 &&
    metadata.every(({ item }) => !!item && item.weightG <= 22679.6) &&
    (!frozen || settings.insulatedPackaging);
  const tipCents =
    tipPercent === null
      ? Math.max(0, Math.round((Number(customTip) || 0) * 100))
      : Math.round((subtotal * tipPercent) / 100);
  const input = useMemo<CheckoutInput>(
    () => ({
      lines,
      fulfillment,
      contact,
      address,
      notes,
      leaveAtDoor: frozen ? false : leaveAtDoor,
      slot: schedule && fulfillment === "pickup" ? slot : "asap",
      promoCode: appliedPromo,
      tipCents,
    }),
    [lines, fulfillment, contact, address, notes, frozen, leaveAtDoor, schedule, slot, appliedPromo, tipCents],
  );
  const currentKey = JSON.stringify(input);
  const quotePending = !quote || quoteKey !== currentKey;

  useEffect(() => {
    let active = true;
    services.checkout.quote(input).then((value) => {
      if (active) { setQuote(value); setQuoteKey(JSON.stringify(input)); }
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : "Could not estimate your order.");
    });
    return () => { active = false; };
  }, [services, input]);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      if (query.trim().length < 3) { setSuggestions([]); return; }
      setSearching(true);
      services.addresses.search(query)
        .then((results) => { if (active) setSuggestions(results); })
        .catch(() => { if (active) setError("Address lookup is unavailable."); })
        .finally(() => { if (active) setSearching(false); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [query, services]);

  const [slots] = useState(() => {
    const first = new Date();
    first.setHours(10, 0, 0, 0);
    if (first.getTime() <= Date.now()) first.setDate(first.getDate() + 1);
    return Array.from({ length: 6 }, (_, i) => {
      const date = new Date(first);
      date.setDate(date.getDate() + i);
      return {
        value: date.toISOString(),
        label: date.toLocaleString("en-US", {
          weekday: "short", month: "short", day: "numeric", hour: "numeric",
        }),
      };
    });
  });

  async function pay(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    setError("");
    if (schedule && slot === "asap") {
      setError("Choose a pickup time within the next six days.");
      return;
    }
    if (payState !== "idle") return;
    setPayState("pending");
    try {
      let request = input;
      if (outcome === "out-of-stock")
        request = { ...input, lines: input.lines.map((l, i) => (i === 0 ? { ...l, listingId: "demo-unavailable" } : l)) };
      if (outcome === "outside-radius")
        request = {
          ...input,
          fulfillment: "courier",
          address: { id: "demo-outside", label: "Outside service area", street: "Demo address", city: "Demo City", state: "MD", zip: "20910", distanceMi: settings.deliveryRadiusMi + 10 },
        };
      const latest = await services.checkout.quote(request);
      if (latest.problems.length)
        throw new Error(latest.problems.map((p) => p.message).filter((v, i, a) => a.indexOf(v) === i).join(" "));
      const authorization = await services.payment.authorize(latest, outcome === "declined" ? "declined" : "success");
      const order = await services.checkout.place(
        request,
        outcome === "session-expired" ? { ...latest, expiresAt: new Date(0).toISOString() } : latest,
        authorization,
      );
      setPayState("success");
      await clearCart();
      await refreshCart();
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches)
        await new Promise((r) => setTimeout(r, 650));
      router.push(`/order/${order.token}?placed=1`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "We could not place your demo order.");
      setPayState("idle");
    }
  }

  if (!ready) return <FlowLoading />;
  if (!lines.length && payState !== "success")
    return (
      <div className={styles.page}>
        <FlowHeading title="Checkout" />
        <EmptyState title="Your basket is waiting" description="Add your favorites before checking out." />
      </div>
    );

  const demoPaymentSection = (
    <>
      <p>Demo payment method <strong>Test wallet</strong></p>
      <p className={styles.muted}>No card details, real authorization, or charge. Payment and fees are simulated.</p>
    </>
  );
  const demoOutcomeSelector = (
    <label className={styles.field}>
      Demo outcome
      <select value={outcome} onChange={(e) => setOutcome(e.target.value as Outcome)}>
        <option value="success">Successful order</option>
        <option value="declined">Payment declined</option>
        <option value="out-of-stock">Item unavailable</option>
        <option value="outside-radius">Address outside delivery radius</option>
        <option value="session-expired">Expired checkout session</option>
      </select>
    </label>
  );

  return (
    <CheckoutLayout
      settings={settings}
      catalog={catalog}
      lines={lines}
      subtotal={subtotal}
      fulfillment={fulfillment}
      setFulfillment={setFulfillment}
      contact={contact}
      setContact={setContact}
      address={address}
      setAddress={setAddress}
      query={query}
      setQuery={setQuery}
      suggestions={suggestions}
      setSuggestions={setSuggestions}
      searching={searching}
      notes={notes}
      setNotes={setNotes}
      leaveAtDoor={leaveAtDoor}
      setLeaveAtDoor={setLeaveAtDoor}
      schedule={schedule}
      setSchedule={setSchedule}
      slot={slot}
      setSlot={setSlot}
      slots={slots}
      promo={promo}
      setPromo={setPromo}
      appliedPromo={appliedPromo}
      setAppliedPromo={setAppliedPromo}
      promoMessage={promoMessage}
      setPromoMessage={setPromoMessage}
      tipPercent={tipPercent}
      setTipPercent={setTipPercent}
      customTip={customTip}
      setCustomTip={setCustomTip}
      quote={quote}
      quotePending={quotePending}
      error={error}
      submitted={submitted}
      payState={payState}
      frozen={frozen}
      weightG={weightG}
      courierEligible={courierEligible}
      onSubmit={pay}
      paymentSection={demoPaymentSection}
      payLabel={quote ? `Place demo order · ${money(quote.totalCents)}` : "Place demo order"}
      isRealPayment={false}
      outcomeSelector={demoOutcomeSelector}
    />
  );
}
