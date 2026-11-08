"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Clock, MapPin, ShoppingBag, Truck } from "lucide-react";
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
  confirmAddressAction,
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
import { checkoutCardView } from "@/lib/customer-account/checkout-card-view";
import { SAVED_CARD_PURPOSE } from "@/lib/customer-account/copy";
import type { CheckoutPrefill } from "@/lib/customer-account/checkout-profile";
import styles from "./cart-checkout.module.css";

type Outcome =
  | "success"
  | "declined"
  | "out-of-stock"
  | "outside-radius"
  | "session-expired";

interface StripeConfig {
  publishableKey: string;
  onBehalfOf?: string;
  harness?: boolean;
  signedIn?: boolean;
  prefill?: CheckoutPrefill | null;
}

export interface CheckoutPageProps extends ShoppingFlowProps {
  stripeConfig?: StripeConfig;
}

const stripePromiseMap = new Map<string, Promise<StripeJs | null>>();
function getStripePromise(config: StripeConfig): Promise<StripeJs | null> {
  let cached = stripePromiseMap.get(config.publishableKey);
  if (!cached) {
    cached = loadStripe(config.publishableKey);
    stripePromiseMap.set(config.publishableKey, cached);
  }
  return cached;
}

function StripeCardInput({ harness }: { harness?: boolean }) {
  if (harness) {
    return (
      <p className={styles.muted}>
        Card entry is simulated for this test. No card number is collected.
      </p>
    );
  }
  return (
    <div className={styles.stripeCard}>
      <PaymentElement options={{ layout: "tabs" }} />
    </div>
  );
}

function createHarnessStripe(): StripeJs {
  const element = {
    on: () => element,
    off: () => element,
    mount: () => element,
    unmount: () => element,
    destroy: () => undefined,
    update: () => element,
  };
  const elementsApi = {
    submit: async () => ({ error: undefined }),
    update: async () => ({ error: undefined }),
    getElement: () => element,
    create: () => element,
    fetchUpdates: async () => ({ error: undefined }),
  };
  return {
    elements: () => elementsApi,
    // @stripe/react-stripe-js rejects a Stripe object that lacks these.
    createToken: async () => ({ token: undefined }),
    createPaymentMethod: async () => ({ paymentMethod: undefined }),
    confirmCardPayment: async () => ({ error: undefined }),
    confirmPayment: async (options: {
      clientSecret?: string;
      confirmParams?: { payment_method?: string };
    }) => {
      const id = String(options.clientSecret ?? "").split("_secret")[0];
      const res = await fetch("/api/e2e/fake-confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          paymentIntentId: id,
          paymentMethodId: options.confirmParams?.payment_method ?? null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.error) {
        return { error: { message: typeof body.error === "string" ? body.error : "Payment failed" } };
      }
      return { error: undefined };
    },
  } as unknown as StripeJs;
}

interface AddressSuggestion {
  line1: string;
  city: string;
  state: string;
  zip: string;
  label: string;
}

interface ConfirmedDelivery {
  formatted: string;
  line1: string;
  city: string;
  state: string;
  zip: string;
  withinRadius: boolean;
  distanceMi: number;
  message: string | null;
}

function StoreDeliveryFields({
  line1,
  setLine1,
  line2,
  setLine2,
  city,
  setCity,
  region,
  setRegion,
  zip,
  setZip,
  suggestions,
  onPick,
  onConfirm,
  confirming,
  confirmed,
  leaveAtDoor,
  setLeaveAtDoor,
  frozen,
  onEdit,
}: {
  line1: string;
  setLine1: (value: string) => void;
  line2: string;
  setLine2: (value: string) => void;
  city: string;
  setCity: (value: string) => void;
  region: string;
  setRegion: (value: string) => void;
  zip: string;
  setZip: (value: string) => void;
  suggestions: AddressSuggestion[];
  onPick: (row: AddressSuggestion) => void;
  onConfirm: () => void;
  confirming: boolean;
  confirmed: ConfirmedDelivery | null;
  leaveAtDoor: boolean;
  setLeaveAtDoor: (value: boolean) => void;
  frozen: boolean;
  onEdit: () => void;
}) {
  return (
    <div>
      <label className={styles.field}>
        Street address
        <input
          autoComplete="address-line1"
          value={line1}
          onChange={(event) => {
            setLine1(event.target.value);
            onEdit();
          }}
        />
      </label>
      <label className={styles.field}>
        Apartment, suite (optional)
        <input
          autoComplete="address-line2"
          maxLength={60}
          value={line2}
          onChange={(event) => setLine2(event.target.value)}
        />
      </label>
      <label className={styles.field}>
        City
        <input autoComplete="address-level2" value={city} onChange={(event) => { setCity(event.target.value); onEdit(); }} />
      </label>
      <label className={styles.field}>
        State
        <input autoComplete="address-level1" maxLength={40} value={region} onChange={(event) => { setRegion(event.target.value); onEdit(); }} />
      </label>
      <label className={styles.field}>
        ZIP
        <input autoComplete="postal-code" maxLength={10} value={zip} onChange={(event) => { setZip(event.target.value); onEdit(); }} />
      </label>
      {suggestions.map((row) => (
        <button
          type="button"
          className={styles.addressResult}
          key={row.label}
          onClick={() => onPick(row)}
        >
          <MapPin size={20} />
          <span>{row.label}</span>
        </button>
      ))}
      <Button type="button" onClick={onConfirm} disabled={confirming}>
        {confirming ? "Checking address…" : "Confirm address"}
      </Button>
      {confirmed && (
        <p role="status">
          {confirmed.formatted}
          {confirmed.withinRadius
            ? ` · ${confirmed.distanceMi.toFixed(1)} mi`
            : ` — ${confirmed.message}`}
        </p>
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
  const [fulfillment, setFulfillment] = useState<Fulfillment>("pickup");
  const prefill = stripeConfig.prefill ?? null;
  const cardView = checkoutCardView({
    signedIn: Boolean(stripeConfig.signedIn),
    cards: (prefill?.cards ?? []).map((card) => ({
      id: card.id,
      brand: card.brand,
      last4: card.last4,
      expMonth: card.expMonth,
      expYear: card.expYear,
      consented: card.reusable,
      created: card.created,
    })),
    now: new Date(),
  });
  const [contact, setContact] = useState(
    () => prefill?.contact ?? { name: "", phone: "", email: "" },
  );
  const [saveCard, setSaveCard] = useState(false);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(cardView.preselectedId);
  const [showCardForm, setShowCardForm] = useState(cardView.showCardForm);
  const [attemptToken, setAttemptToken] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [line1, setLine1] = useState("");
  const [line2, setLine2] = useState("");
  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  const [zip, setZip] = useState("");
  const [leaveAtDoor, setLeaveAtDoor] = useState(false);
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [confirmed, setConfirmed] = useState<ConfirmedDelivery | null>(null);
  const [confirming, setConfirming] = useState(false);
  const suggestAbort = useRef<AbortController | null>(null);
  const [schedule, setSchedule] = useState(false);
  const [slot, setSlot] = useState("asap");
  const [quote, setQuote] = useState<CheckoutQuote | null>(null);
  const [quoteKey, setQuoteKey] = useState("");
  const [error, setError] = useState("");
  const [errorHref, setErrorHref] = useState<string | null>(null);
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
  const delivery = fulfillment === "store-delivery" && confirmed
    ? {
        line1: confirmed.line1,
        line2: line2 || null,
        city: confirmed.city,
        state: confirmed.state,
        zip: confirmed.zip,
        leaveAtDoor: !frozen && leaveAtDoor,
      }
    : undefined;
  const currentKey = JSON.stringify({ contact, fulfillment, delivery });
  const quotePending = !quote || quoteKey !== currentKey;

  useEffect(() => {
    if (confirmed || line1.trim().length < 3 || fulfillment !== "store-delivery") return;
    const controller = new AbortController();
    suggestAbort.current = controller;
    const timer = setTimeout(() => {
      fetch(`/api/address/suggest?q=${encodeURIComponent(line1)}`, { signal: controller.signal })
        .then((response) => response.json())
        .then((body: { suggestions?: AddressSuggestion[] }) => {
          if (!controller.signal.aborted) setSuggestions(body.suggestions ?? []);
        })
        .catch(() => {
          if (!controller.signal.aborted) setSuggestions([]);
        });
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [line1, fulfillment, confirmed]);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      quoteCheckoutAction(contact, fulfillment, delivery).then((result) => {
        if (!active) return;
        if (result.ok) {
          setQuote(result.quote);
          setQuoteKey(JSON.stringify({ contact, fulfillment, delivery }));
        } else {
          setError(result.error);
        }
      });
    }, 300);
    return () => { active = false; clearTimeout(timer); };
    // currentKey already covers contact, fulfillment, and the confirmed address.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey]);

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
    setErrorHref(null);
    if (schedule && slot === "asap") {
      setError("Choose a pickup time within the next six days.");
      return;
    }
    if (fulfillment === "store-delivery" && !delivery) {
      setError("Confirm your delivery address.");
      return;
    }
    if (payState !== "idle") return;
    if (!stripe || !elements) {
      setError("Payment is still loading. Try again in a moment.");
      return;
    }
    suggestAbort.current?.abort();
    setSuggestions([]);
    setPayState("pending");
    try {
      const quoteResult = await quoteCheckoutAction(contact, fulfillment, delivery);
      if (!quoteResult.ok) {
        if (quoteResult.code === "basket_already_ordered") {
          setErrorHref("/account");
          setError(quoteResult.error);
          setPayState("idle");
          return;
        }
        throw new Error(quoteResult.error);
      }
      if (quoteResult.orderedToken) {
        setPayState("success");
        await refreshCart();
        router.push(`/order/${quoteResult.orderedToken}?placed=1`);
        return;
      }
      const latest = quoteResult.quote;
      if (latest.problems.length) {
        throw new Error(
          latest.problems
            .map((p: { message: string }) => p.message)
            .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i)
            .join(" "),
        );
      }

      const payingSavedCard = Boolean(selectedCardId) && !showCardForm;
      const piResult = await createPaymentIntentAction(
        contact,
        fulfillment,
        stripeConfig.signedIn
          ? {
              saveCard: payingSavedCard ? false : saveCard,
              savedCardId: payingSavedCard ? selectedCardId : null,
              attemptToken,
            }
          : undefined,
        delivery,
      );
      if (!piResult.ok) {
        if (piResult.code === "basket_already_ordered") {
          setErrorHref("/account");
          setError(piResult.error);
          setPayState("idle");
          return;
        }
        if (piResult.code === "saved_card_unavailable") {
          setSelectedCardId(null);
          setShowCardForm(true);
          setSaveCard(false);
        }
        throw new Error(piResult.error);
      }
      if ("orderedToken" in piResult) {
        setPayState("success");
        await refreshCart();
        router.push(`/order/${piResult.orderedToken}?placed=1`);
        return;
      }
      if (piResult.attemptToken) setAttemptToken(piResult.attemptToken);

      let confirmError: { message?: string } | undefined;
      if (payingSavedCard && selectedCardId) {
        const confirmed = await stripe.confirmPayment({
          clientSecret: piResult.clientSecret,
          confirmParams: {
            return_url: window.location.href,
            payment_method: selectedCardId,
          },
          redirect: "if_required",
        });
        confirmError = confirmed.error;
      } else {
        await Promise.resolve(elements.update({
          amount: piResult.holdCents,
          setupFutureUsage: saveCard ? "on_session" : null,
        }));
        const { error: submitError } = await elements.submit();
        if (submitError) throw new Error(submitError.message ?? "Card validation failed");
        const confirmed = await stripe.confirmPayment({
          elements,
          clientSecret: piResult.clientSecret,
          confirmParams: { return_url: window.location.href },
          redirect: "if_required",
        });
        confirmError = confirmed.error;
      }
      if (confirmError) throw new Error(confirmError.message ?? "Payment failed");

      const orderResult = await placeOrderAction(
        piResult.paymentIntentId,
        contact,
        fulfillment,
        notes,
        schedule ? slot : "asap",
        delivery,
      );
      if (!orderResult.ok) {
        setErrorHref(orderResult.code === "basket_already_ordered" ? "/account" : null);
        if (orderResult.code === "basket_changed" || orderResult.code === "basket_already_ordered") {
          setError(orderResult.error);
          setPayState("idle");
          return;
        }
        throw new Error(orderResult.error);
      }
      setErrorHref(null);

      setPayState("success");
      await refreshCart();
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches)
        await new Promise((r) => setTimeout(r, 650));
      router.push(`/order/${orderResult.token}?placed=1`);
    } catch (reason) {
      setErrorHref(null);
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
      deliveryEditor={
        <StoreDeliveryFields
          line1={line1}
          setLine1={setLine1}
          line2={line2}
          setLine2={setLine2}
          city={city}
          setCity={setCity}
          region={region}
          setRegion={setRegion}
          zip={zip}
          setZip={setZip}
          suggestions={suggestions}
          onPick={(row) => {
            setLine1(row.line1);
            setCity(row.city);
            setRegion(row.state);
            setZip(row.zip);
            setSuggestions([]);
            setConfirmed(null);
          }}
          onConfirm={() => {
            setConfirming(true);
            confirmAddressAction({
              line1,
              line2: line2 || null,
              city,
              state: region,
              zip,
              leaveAtDoor: !frozen && leaveAtDoor,
            }).then((result) => {
              setConfirming(false);
              if (!result.ok) {
                setConfirmed(null);
                setError(result.error);
                return;
              }
              setError("");
              setSuggestions([]);
              setConfirmed({
                formatted: result.formatted,
                line1: result.line1,
                city: result.city,
                state: result.state,
                zip: result.zip,
                withinRadius: result.withinRadius,
                distanceMi: result.distanceMi,
                message: result.message,
              });
              setLine1(result.line1);
              setCity(result.city);
              setRegion(result.state);
              setZip(result.zip);
            });
          }}
          confirming={confirming}
          confirmed={confirmed}
          leaveAtDoor={leaveAtDoor}
          setLeaveAtDoor={setLeaveAtDoor}
          frozen={frozen}
          onEdit={() => {
            setConfirmed(null);
            setSuggestions([]);
          }}
        />
      }
      contact={contact}
      setContact={setContact}
      address={undefined}
      setAddress={() => {}}
      query=""
      setQuery={() => {}}
      suggestions={[]}
      setSuggestions={() => {}}
      searching={false}
      notes={notes}
      setNotes={setNotes}
      leaveAtDoor={false}
      setLeaveAtDoor={() => {}}
      schedule={schedule}
      setSchedule={setSchedule}
      slot={slot}
      setSlot={setSlot}
      slots={slots}
      promo=""
      setPromo={() => {}}
      appliedPromo=""
      setAppliedPromo={() => {}}
      promoMessage=""
      setPromoMessage={() => {}}
      tipPercent={0}
      setTipPercent={() => {}}
      customTip=""
      setCustomTip={() => {}}
      quote={quote}
      quotePending={quotePending}
      error={error}
      errorHref={errorHref}
      submitted={submitted}
      payState={payState}
      frozen={frozen}
      weightG={weightG}
      courierEligible={false}
      onSubmit={pay}
      signedIn={Boolean(stripeConfig.signedIn)}
      paymentSection={
        <>
          {prefill?.cardsUnavailable ? <p>Saved cards are unavailable right now</p> : null}
          {cardView.selectable.map((card) => (
            <label className={styles.choice} key={card.id}>
              <input
                type="radio"
                name="saved-card"
                checked={selectedCardId === card.id && !showCardForm}
                onChange={() => {
                  setSelectedCardId(card.id);
                  setShowCardForm(false);
                  setSaveCard(false);
                }}
              />
              <span>
                {card.brand} ending in {card.last4}, expires {card.expMonth}/{card.expYear}
              </span>
            </label>
          ))}
          {cardView.expired.map((card) => (
            <p key={card.id}>
              {card.brand} ending in {card.last4} · Expired
            </p>
          ))}
          {selectedCardId && !showCardForm ? (
            <button
              type="button"
              className="sf-text-link"
              onClick={() => {
                setSelectedCardId(null);
                setShowCardForm(true);
                setSaveCard(false);
              }}
            >
              Use a different card
            </button>
          ) : null}
          {showCardForm ? <StripeCardInput harness={stripeConfig.harness} /> : null}
          {cardView.showSaveTick && showCardForm ? (
            <label className={styles.choice}>
              <input
                type="checkbox"
                checked={saveCard}
                onChange={(event) => setSaveCard(event.target.checked)}
              />
              <span>
                Save this card for next time
                <small>{SAVED_CARD_PURPOSE}</small>
              </span>
            </label>
          ) : null}
        </>
      }
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
  const { lines, subtotal } = useCart();

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

  if (stripeConfig?.publishableKey) {
    const estimatedHold = subtotal + Math.min(Math.round(subtotal * 0.10), 2000);
    return (
      <StripeWrapper config={stripeConfig} estimatedHoldCents={estimatedHold}>
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
  estimatedHoldCents,
  children,
}: {
  config: StripeConfig;
  estimatedHoldCents: number;
  children: React.ReactNode;
}) {
  const stripePromise = useMemo(
    () => (config.harness ? Promise.resolve(createHarnessStripe()) : getStripePromise(config)),
    [config],
  );
  const amount = Math.max(estimatedHoldCents, 50);
  return (
    <Elements
      stripe={stripePromise}
      options={{
        mode: "payment",
        amount,
        currency: "usd",
        captureMethod: "manual",
        onBehalfOf: config.onBehalfOf,
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
  errorHref?: string | null;
  submitted: boolean;
  payState: "idle" | "pending" | "success";
  signedIn?: boolean;
  identityLocked?: boolean;
  frozen: boolean;
  weightG: number;
  courierEligible: boolean;
  onSubmit: (e: FormEvent) => void;
  paymentSection: React.ReactNode;
  payLabel: string;
  isRealPayment: boolean;
  outcomeSelector?: React.ReactNode;
  deliveryEditor?: React.ReactNode;
}

function CheckoutLayout(props: CheckoutLayoutProps) {
  const {
    settings, lines, fulfillment, setFulfillment,
    contact, setContact, address, setAddress, query, setQuery,
    suggestions, setSuggestions, searching, notes, setNotes,
    leaveAtDoor, setLeaveAtDoor, schedule, setSchedule,
    slot, setSlot, slots, promo, setPromo,
    setAppliedPromo, promoMessage, setPromoMessage,
    tipPercent, setTipPercent, customTip, setCustomTip,
    quote, quotePending, error, errorHref, submitted, payState,
    frozen, weightG, courierEligible,
    onSubmit, paymentSection, payLabel, isRealPayment, outcomeSelector, deliveryEditor,
    signedIn = false, identityLocked = false,
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
                    Store delivery · {settings.storeDeliveryFeeCents === 0 ? "Free" : money(settings.storeDeliveryFeeCents)}
                  </Chip>
                )}
                {!isRealPayment && (
                  <Chip
                    type="button"
                    selected={fulfillment === "courier"}
                    disabled={!courierEligible}
                    onClick={() => setFulfillment("courier")}
                  >
                    <Truck size={18} />
                    Courier · {money(699)} demo quote
                  </Chip>
                )}
              </div>
              <p className={styles.muted}>
                Order weight: {(weightG / 453.592).toFixed(1)} lb. Delivery
                radius: {settings.deliveryRadiusMi} miles.
              </p>
              {!isRealPayment && !courierEligible && (
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
              ) : deliveryEditor ? (
                deliveryEditor
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
              <div className={styles.queueNotice}>
                <Clock size={18} aria-hidden />
                <p>
                  <strong>
                    Opens {settings.opensAt} · ready about {settings.readyAt}
                  </strong>
                  The market is closed. Order now to join the queue.
                </p>
              </div>
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
                {signedIn
                  ? "We filled your name and email from your account. Edits apply to this order only."
                  : "Guest checkout. A phone number helps your shopper reach you about substitutions."}
              </p>
              <label className={styles.field}>
                Full name
                <input
                  autoComplete="name"
                  required
                  readOnly={identityLocked}
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
                  readOnly={identityLocked}
                  value={contact.email}
                  aria-invalid={submitted && !contact.email.trim()}
                  onChange={(e) => setContact({ ...contact, email: e.target.value })}
                />
              </label>
              {submitted && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email.trim()) && (
                <p className={styles.error}>Enter a valid email address.</p>
              )}
            </FlowCard>
          </div>
          {fulfillment !== "pickup" && (
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
          )}
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
            {!isRealPayment && (
              <>
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
              </>
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
            {error && (
              <FlowError title="Let's review that" message={error}>
                {errorHref ? <Link className="sf-text-link" href={errorHref}>View your orders</Link> : null}
              </FlowError>
            )}
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
