"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { MapPin, ShoppingBag, Truck } from "lucide-react";
import { useCart } from "../cart-provider";
import { Button, Chip, EmptyState } from "../primitives";
import { createDemoServices } from "@/lib/customer-flow/demo-adapters";
import { cartItemKey } from "@/lib/storefront/cart-store";
import { clearCart } from "@/lib/cart/actions";
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
export function CheckoutPage({
  settings,
  catalog,
  enabled,
}: ShoppingFlowProps) {
  const { lines, subtotal, store } = useCart();
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
  const [payState, setPayState] = useState<"idle" | "pending" | "success">(
    "idle",
  );
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
    [
      lines,
      fulfillment,
      contact,
      address,
      notes,
      frozen,
      leaveAtDoor,
      schedule,
      slot,
      appliedPromo,
      tipCents,
    ],
  );
  const currentKey = JSON.stringify(input);
  const quotePending = !quote || quoteKey !== currentKey;
  useEffect(() => {
    let active = true;
    services.checkout
      .quote(input)
      .then((value) => {
        if (active) {
          setQuote(value);
          setQuoteKey(JSON.stringify(input));
        }
      })
      .catch((reason) => {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not estimate your order. Please retry.",
          );
      });
    return () => {
      active = false;
    };
  }, [services, input]);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      if (query.trim().length < 3) {
        setSuggestions([]);
        return;
      }
      setSearching(true);
      services.addresses
        .search(query)
        .then((results) => {
          if (active) setSuggestions(results);
        })
        .catch(() => {
          if (active)
            setError("Address lookup is unavailable. Try searching again.");
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, services]);
  const [slots] = useState(() => {
    const first = new Date();
    first.setHours(10, 0, 0, 0);
    if (first.getTime() <= Date.now()) first.setDate(first.getDate() + 1);
    return Array.from({ length: 6 }, (_, index) => {
      const date = new Date(first);
      date.setDate(date.getDate() + index);
      return {
        value: date.toISOString(),
        label: date.toLocaleString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
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
        request = {
          ...input,
          lines: input.lines.map((line, index) =>
            index === 0 ? { ...line, listingId: "demo-unavailable" } : line,
          ),
        };
      if (outcome === "outside-radius")
        request = {
          ...input,
          fulfillment: "courier",
          address: {
            id: "demo-outside",
            label: "Outside service area",
            street: "Demo address",
            city: "Demo City",
            state: "MD",
            zip: "20910",
            distanceMi: settings.deliveryRadiusMi + 10,
          },
        };
      const latest = await services.checkout.quote(request);
      if (latest.problems.length)
        throw new Error(
          latest.problems
            .map((problem) => problem.message)
            .filter((value, index, all) => all.indexOf(value) === index)
            .join(" "),
        );
      const authorization = await services.payment.authorize(
        latest,
        outcome === "declined" ? "declined" : "success",
      );
      const order = await services.checkout.place(
        request,
        outcome === "session-expired"
          ? { ...latest, expiresAt: new Date(0).toISOString() }
          : latest,
        authorization,
      );
      setPayState("success");
      await clearCart();
      lines.forEach((line) => store.remove(cartItemKey(line)));
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches)
        await new Promise((resolve) => setTimeout(resolve, 650));
      router.push(`/order/${order.token}?placed=1`);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "We could not place your demo order. Your basket is saved.",
      );
      setPayState("idle");
    }
  }
  if (!ready) return <FlowLoading />;
  if (!lines.length && payState !== "success")
    return (
      <div className={styles.page}>
        <FlowHeading title="Checkout" />
        <EmptyState
          title="Your basket is waiting"
          description="Add your favorites before checking out."
        />
      </div>
    );
  return (
    <div className={styles.page}>
      <FlowHeading
        title="A little closer to home"
        description="Review your order and choose how it reaches you."
        backHref="/cart"
        backLabel="Back to basket"
      />
      <DemoNotice />
      <nav className={styles.stages} aria-label="Checkout sections">
        <a href="#fulfillment">1. Fulfillment</a>
        <a href="#contact">2. Contact</a>
        <a href="#payment">3. Payment</a>
        <a href="#review">4. Review</a>
      </nav>
      <form className={styles.layout} onSubmit={pay} noValidate>
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
                  Courier · {money(699)} demo quote
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
                      placeholder="Search a demo street address"
                    />
                  </label>
                  <p className={styles.muted}>
                    Simulated lookup: enter at least 3 characters. Addresses and
                    distance are demo data.
                  </p>
                  {searching && <p role="status">Finding demo addresses…</p>}
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
                  {address && (
                    <AddressCard address={address} title="Delivery to" />
                  )}
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
                minutes after opening. The demo hold is placed now.
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
                  onClick={() => {
                    setSchedule(true);
                    setSlot(slots[0].value);
                  }}
                >
                  Schedule pickup
                </Chip>
              )}
            </div>
            {schedule && fulfillment === "pickup" && (
              <label className={styles.field}>
                Pickup time
                <select
                  value={slot}
                  onChange={(event) => setSlot(event.target.value)}
                >
                  {slots.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
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
                onChange={(event) => setNotes(event.target.value)}
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
                  onChange={(event) =>
                    setContact({ ...contact, name: event.target.value })
                  }
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
                  onChange={(event) =>
                    setContact({ ...contact, phone: event.target.value })
                  }
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
                Email (optional)
                <input
                  autoComplete="email"
                  type="email"
                  value={contact.email}
                  onChange={(event) =>
                    setContact({ ...contact, email: event.target.value })
                  }
                />
              </label>
              <p className={styles.muted}>
                Demo only: no text messages or emails are sent.
              </p>
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
                  onChange={(event) => setCustomTip(event.target.value)}
                />
              </label>
            )}
          </FlowCard>
          <div id="payment" className={styles.anchor}>
            <FlowCard title="Test payment">
              <p>
                Demo payment method <strong>Test wallet</strong>
              </p>
              <p className={styles.muted}>
                No card details, real authorization, or charge. Payment and fees
                are simulated.
              </p>
              <label className={styles.field}>
                Demo outcome
                <select
                  value={outcome}
                  onChange={(event) =>
                    setOutcome(event.target.value as Outcome)
                  }
                >
                  <option value="success">Successful order</option>
                  <option value="declined">Payment declined</option>
                  <option value="out-of-stock">Item unavailable</option>
                  <option value="outside-radius">
                    Address outside delivery radius
                  </option>
                  <option value="session-expired">
                    Expired checkout session
                  </option>
                </select>
              </label>
            </FlowCard>
          </div>
        </fieldset>
        <aside id="review" className={`${styles.sticky} ${styles.anchor}`}>
          <FlowCard title="Your order">
            <p className={styles.muted}>
              {settings.name} ·{" "}
              {lines.reduce((sum, line) => sum + line.quantity, 0)} items{" "}
              <Link className="sf-text-link" href="/cart">
                Edit basket
              </Link>
            </p>
            <ul className={styles.miniLines}>
              {lines.map((line) => (
                <li key={cartItemKey(line)}>
                  <span>
                    {line.quantity} × {line.name}
                  </span>
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
                  onChange={(event) => setPromo(event.target.value)}
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
                          ? "That demo code is not valid. Try WELCOME10."
                          : "Promo removed.",
                    );
                  }}
                >
                  Apply
                </Button>
              </div>
            </label>
            {promoMessage && (
              <p className={styles.muted} role="status">
                {promoMessage}
              </p>
            )}
            {quote ? (
              <>
                <FeeLine label="Subtotal" cents={quote.subtotalCents} />
                <FeeLine
                  label="Store delivery"
                  cents={quote.deliveryFeeCents}
                />
                <FeeLine
                  label={
                    quote.courierProvider
                      ? `${quote.courierProvider} · demo quote`
                      : "Courier"
                  }
                  cents={quote.courierFeeCents}
                  detail={
                    quote.courierFeeCents
                      ? "Simulated provider quote, no markup"
                      : undefined
                  }
                />
                <FeeLine
                  label="Estimated tax · 6% demo rate"
                  cents={quote.taxCents}
                />
                <FeeLine label="Tip" cents={quote.tipCents} />
                {!!quote.discountCents && (
                  <FeeLine label="Promo savings" cents={-quote.discountCents} />
                )}
                <FeeLine
                  label="Estimated total"
                  cents={quote.totalCents}
                  strong
                />
                <FeeLine
                  label="Temporary swap buffer"
                  cents={quote.bufferCents}
                />
                <FeeLine
                  label="Demo authorization hold"
                  cents={quote.holdCents}
                  strong
                />
              </>
            ) : (
              <p role="status">Estimating your order…</p>
            )}
            <p className={styles.notice}>
              {quote && (
                <>
                  Your card is held for {money(quote.holdCents)} now in this
                  demo. We charge the final amount after picking, which is never
                  more than the hold.{" "}
                </>
              )}
              We authorize the estimated total plus a 10% buffer, capped at $20.
              You’ll be charged the final amount after picking; unused funds are
              released. Any higher-priced swap requires your approval and must
              fit within this hold.
            </p>
            {quotePending && (
              <p className={styles.muted} role="status">
                Updating estimate…
              </p>
            )}
            {error && <FlowError title="Let’s review that" message={error} />}
            <PayButton
              type="submit"
              state={payState}
              disabled={payState !== "idle" || quotePending}
              label={
                quote
                  ? `Place demo order · ${money(quote.totalCents)}`
                  : "Place demo order"
              }
            />
            <p className={styles.muted}>
              By placing this demo order, you approve the simulated hold and
              your fulfillment choices.
            </p>
          </FlowCard>
        </aside>
      </form>
    </div>
  );
}
