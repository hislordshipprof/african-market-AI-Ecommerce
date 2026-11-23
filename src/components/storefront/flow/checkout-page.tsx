"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, Clock, MapPin, Package, ShoppingBag, Truck } from "lucide-react";
import { loadStripe, type Appearance, type Stripe as StripeJs } from "@stripe/stripe-js";
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
import { cateringLeadText } from "@/lib/listing/catering";
import { clearCart } from "@/lib/cart/actions";
import {
  quoteCheckoutAction,
  applyCouponAction,
  removeCouponAction,
  createPaymentIntentAction,
  placeOrderAction,
  confirmAddressAction,
  assistantCheckoutDraftAction,
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
  FlowCard,
  FlowError,
  FlowHeading,
  FlowLoading,
  QuoteLines,
} from "./common";
import { PayButton } from "./feedback";
import { CheckoutIssueAlert, type IssueActions } from "./checkout-issue-alert";
import {
  checkoutBasketBlock,
  contactErrors,
  flaggedLineKeys,
  firstInvalidContactField,
  issueFromError,
  issueFromProblems,
  type CheckoutIssue,
  type IssueSection,
} from "@/lib/checkout/checkout-issue";
import { settleWithTimeout } from "./settle";
import { money, useCartReady, type ShoppingFlowProps } from "./cart-page";
import { checkoutQuoteKey, placeOrderLabel } from "@/lib/checkout/summary";
import { activeSection } from "@/lib/checkout/active-section";
import { checkoutCardView } from "@/lib/customer-account/checkout-card-view";
import { SAVED_CARD_PURPOSE } from "@/lib/customer-account/copy";
import type { CheckoutPrefill } from "@/lib/customer-account/checkout-profile";
import type { SlotOptions } from "@/lib/checkout/slots";
import { CouponField } from "./coupon-field";
import styles from "./cart-checkout.module.css";

type Outcome =
  | "success"
  | "declined"
  | "out-of-stock"
  | "outside-radius"
  | "session-expired";

/** A quote request that takes longer than this is treated as failed, so checkout never hangs (#708 AC2b). */
const QUOTE_TIMEOUT_MS = 12_000;
const ADDRESS_TIMEOUT_MS = 12_000;

interface StripeConfig {
  publishableKey: string;
  onBehalfOf?: string;
  harness?: boolean;
  signedIn?: boolean;
  prefill?: CheckoutPrefill | null;
  /** Pickup times drawn with the page, so they show before the first quote (#565). */
  pickupSlots?: SlotOptions;
  /** The store has a registered WhatsApp number, so checkout offers order updates there (#560). */
  whatsappUpdates?: boolean;
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
      <PaymentElement options={{ layout: "tabs", wallets: { link: "never" } }} />
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
  shipping,
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
  /** A shipped order: no delivery radius and no leave at door (#567). */
  shipping: boolean;
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
          {shipping
            ? ""
            : confirmed.withinRadius
              ? ` · ${confirmed.distanceMi.toFixed(1)} mi`
              : ` — ${confirmed.message}`}
        </p>
      )}
      {!shipping && (
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={!frozen && leaveAtDoor}
            disabled={frozen}
            onChange={(event) => setLeaveAtDoor(event.target.checked)}
          />
          Leave at door
        </label>
      )}
    </div>
  );
}

/** After "Use another card": the card entry gets focus, or the payment section when the entry is simulated. */
function focusPaymentEntry(card?: { focus?: () => void } | null) {
  requestAnimationFrame(() => {
    if (card?.focus) {
      card.focus();
      return;
    }
    const section = document.getElementById("payment");
    section?.scrollIntoView({ block: "start" });
    const target = section?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), button:not([disabled])") ?? section;
    target?.focus();
  });
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
  const { lines, subtotal, refreshCart, syncing } = useCart();
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
  const [whatsappUpdates, setWhatsappUpdates] = useState(false);
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
  // Server-computed times for the chosen fulfillment, in store time (#565).
  const [slotOptions, setSlotOptions] = useState<SlotOptions | null>(stripeConfig.pickupSlots ?? null);
  const [quoteKey, setQuoteKey] = useState("");
  // The quote refused, rejected, or timed out: a visible failure with Retry, never a stuck "estimating" (#708 AC2b).
  const [quoteFailed, setQuoteFailed] = useState(false);
  const [quoteNonce, setQuoteNonce] = useState(0);
  // A failure placed beside the control it concerns, with its recovery (#717 AC3).
  const [issue, setIssue] = useState<CheckoutIssue | null>(null);
  const [quoteFailMessage, setQuoteFailMessage] = useState<string | undefined>();
  const [errorHref, setErrorHref] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submitAttempt, setSubmitAttempt] = useState(0);
  const [payState, setPayState] = useState<"idle" | "pending" | "success">("idle");
  const fail = (section: IssueSection, message: string, lineKeys: string[] = []) => setIssue({ section, message, lineKeys });
  // Bumped when the cart's code changes, so the quote is asked again (#557).
  const [couponRev, setCouponRev] = useState(0);
  const metadata = lines.map((line) => ({
    line,
    item: catalog.find((item) => cartItemKey(item) === cartItemKey(line)),
  }));
  const frozen = metadata.some(({ item }) => item?.frozen);
  const hot = metadata.some(({ item }) => item?.prepared === "hot");
  // Frozen and hot food are handed over, never left at the door (#570).
  const handoff = frozen || hot;
  const weightG = metadata.reduce(
    (sum, { line, item }) => sum + (item?.weightG ?? 0) * line.quantity,
    0,
  );
  async function applyCoupon(code: string) {
    const result = await applyCouponAction(code);
    if (result.ok) setCouponRev((rev) => rev + 1);
    return result;
  }
  async function removeCoupon() {
    await removeCouponAction();
    setCouponRev((rev) => rev + 1);
  }
  const delivery = fulfillment !== "pickup" && confirmed
    ? {
        line1: confirmed.line1,
        line2: line2 || null,
        city: confirmed.city,
        state: confirmed.state,
        zip: confirmed.zip,
        leaveAtDoor: fulfillment !== "ship" && !handoff && leaveAtDoor,
      }
    : undefined;
  // The basket is part of the key: a change made in the drawer is quoted again (#708 P1).
  const currentKey = checkoutQuoteKey({ contact, fulfillment, delivery, couponRev, lines });
  const quotePending = !quote || quoteKey !== currentKey;

  useEffect(() => {
    if (confirmed || line1.trim().length < 3 || fulfillment === "pickup") return;
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
    const key = currentKey;
    // The quote reads the server basket, so it waits for the drawer's change to land; a sync that never does still fails visibly.
    if (syncing) {
      const stuck = setTimeout(() => { if (active) setQuoteFailed(true); }, QUOTE_TIMEOUT_MS);
      return () => { active = false; clearTimeout(stuck); };
    }
    const timer = setTimeout(() => {
      // Always settles: a rejected or hanging quote ends in a visible failure, not a stuck UI (#708 AC2b).
      settleWithTimeout(() => quoteCheckoutAction(contact, fulfillment, delivery), QUOTE_TIMEOUT_MS).then((settled) => {
        if (!active) return;
        if (!settled.ok) {
          // Rejected or timed out: offer Retry instead of estimating forever.
          setQuoteFailed(true);
          return;
        }
        const result = settled.value;
        if (result.ok) {
          setQuote(result.quote);
          setSlotOptions(result.slots);
          setQuoteKey(key);
          setQuoteFailed(false);
          setQuoteFailMessage(undefined);
        } else {
          // The server refused the quote (a real reason): shown in the estimate's Retry box.
          setQuoteFailMessage(result.error);
          setQuoteFailed(true);
        }
      });
    }, 300);
    return () => { active = false; clearTimeout(timer); };
    // currentKey already covers contact, fulfillment, the confirmed address and the basket; quoteNonce drives Retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, quoteNonce, syncing]);

  function retryQuote() {
    setQuoteFailed(false);
    setQuoteFailMessage(undefined);
    setQuoteNonce((nonce) => nonce + 1);
  }

  const slotRequired = slotOptions?.required === true;
  const slots = (slotOptions?.slots ?? []).map((option) => ({ value: option.id, label: option.label }));
  const scheduled = slotRequired || (schedule && fulfillment === "pickup");
  // A choice the fresh list no longer offers falls back to its first time.
  const chosenSlot = !scheduled
    ? "asap"
    : slots.some((option) => option.value === slot) ? slot : slots[0]?.value ?? "asap";

  function takeFreshSlots(fresh: SlotOptions, message: string) {
    setSlotOptions(fresh);
    setSlot(fresh.slots[0]?.id ?? "asap");
    fail("general", message);
    setPayState("idle");
  }

  // The pickup time chosen with the assistant, in store time (#247). It never
  // overrides a choice the shopper made on this page before it loaded.
  const shopperChose = useRef(false);
  function chosenByShopper<T>(set: (value: T) => void) {
    return (value: T) => { shopperChose.current = true; set(value); };
  }
  useEffect(() => {
    let active = true;
    assistantCheckoutDraftAction().then((draft) => {
      if (!active || !draft || !settings.pickupEnabled || shopperChose.current) return;
      setFulfillment("pickup");
      if (draft.slot.id === "asap") return;
      setSchedule(true);
      setSlot(draft.slot.id);
    }).catch(() => {});
    return () => { active = false; };
  }, [settings.pickupEnabled]);

  async function pay(event: FormEvent) {
    event.preventDefault();
    if (payState !== "idle") return;
    setSubmitted(true);
    setSubmitAttempt((attempt) => attempt + 1);
    setIssue(null);
    setErrorHref(null);
    // In page order: the address card comes before contact. Fields show their own errors; values stay.
    if (fulfillment !== "pickup" && !delivery) {
      fail("address", fulfillment === "ship" ? "Confirm your shipping address." : "Confirm your delivery address.");
      return;
    }
    if (scheduled && chosenSlot === "asap") {
      fail("general", fulfillment === "pickup" ? "Choose a pickup time." : "Choose a delivery time.");
      return;
    }
    if (firstInvalidContactField(contact)) return;
    if (!stripe || !elements) {
      fail("network", "Payment is still loading. Try again in a moment.");
      return;
    }
    suggestAbort.current?.abort();
    setSuggestions([]);
    setPayState("pending");
    try {
      // Bounded like the live estimate: a hung quote ends in Try again, never a stuck button (#708).
      const settledQuote = await settleWithTimeout(() => quoteCheckoutAction(contact, fulfillment, delivery), QUOTE_TIMEOUT_MS);
      if (!settledQuote.ok) {
        fail("network", "We couldn\u2019t confirm your total. Check your connection, then try again.");
        setPayState("idle");
        return;
      }
      const quoteResult = settledQuote.value;
      if (!quoteResult.ok) {
        if (quoteResult.code === "basket_already_ordered") {
          setErrorHref("/account");
          fail("general", quoteResult.error);
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
        const placed = issueFromProblems(latest.problems);
        setIssue(placed?.section === "basket"
          ? { ...placed, lineKeys: flaggedLineKeys(lines) }
          : placed ?? { section: "general", message: [...new Set(latest.problems.map((p) => p.message))].join(" "), lineKeys: [] });
        setPayState("idle");
        return;
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
        chosenSlot,
      );
      if (!piResult.ok) {
        if (piResult.code === "quote_changed") {
          setQuote(piResult.quote);
          setQuoteKey(currentKey);
          fail("general", piResult.error);
          setPayState("idle");
          return;
        }
        if (piResult.code === "slot_unavailable") {
          takeFreshSlots(piResult.slots, piResult.error);
          return;
        }
        if (piResult.code === "basket_already_ordered") {
          setErrorHref("/account");
          fail("general", piResult.error);
          setPayState("idle");
          return;
        }
        if (piResult.code === "saved_card_unavailable") {
          setSelectedCardId(null);
          setShowCardForm(true);
          setSaveCard(false);
          fail("payment", piResult.error);
          setPayState("idle");
          return;
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
        if (submitError) {
          fail("payment", submitError.message ?? "Check your card details.");
          setPayState("idle");
          return;
        }
        const confirmed = await stripe.confirmPayment({
          elements,
          clientSecret: piResult.clientSecret,
          confirmParams: { return_url: window.location.href },
          redirect: "if_required",
        });
        confirmError = confirmed.error;
      }
      if (confirmError) {
        // A decline or card error sits by the card, with Use another card (#717 AC3).
        fail("payment", confirmError.message ?? "Your card was declined.");
        setPayState("idle");
        return;
      }

      const orderResult = await placeOrderAction(
        piResult.paymentIntentId,
        contact,
        fulfillment,
        notes,
        chosenSlot,
        delivery,
        stripeConfig.whatsappUpdates ? whatsappUpdates : false,
      );
      if (!orderResult.ok) {
        if (orderResult.code === "slot_unavailable") {
          // The hold was released; Pay again holds a new one for the new time.
          takeFreshSlots(orderResult.slots, orderResult.error);
          return;
        }
        setErrorHref(orderResult.code === "basket_already_ordered" ? "/account" : null);
        if (orderResult.code === "basket_changed") {
          fail("basket", orderResult.error, flaggedLineKeys(lines));
          setPayState("idle");
          await refreshCart();
          return;
        }
        if (orderResult.code === "basket_already_ordered") {
          fail("general", orderResult.error);
          setPayState("idle");
          return;
        }
        if (orderResult.code === "coupon_refused") {
          // The hold was released and the code taken off; the next quote shows the full price.
          fail("general", orderResult.error);
          setPayState("idle");
          setCouponRev((rev) => rev + 1);
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
      setIssue(issueFromError(reason));
      setPayState("idle");
    }
  }

  function switchCard() {
    setIssue(null);
    if (selectedCardId && !showCardForm) {
      setSelectedCardId(null);
      setShowCardForm(true);
      setSaveCard(false);
    }
    const card = elements?.getElement("payment") as { clear?: () => void; focus?: () => void } | null | undefined;
    card?.clear?.();
    focusPaymentEntry(card);
  }

  function refreshCheckout() {
    setIssue(null);
    retryQuote();
    void refreshCart();
  }

  return (
    <CheckoutLayout
      settings={settings}
      catalog={catalog}
      lines={lines}
      subtotal={subtotal}
      fulfillment={fulfillment}
      setFulfillment={chosenByShopper(setFulfillment)}
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
            // Always settles: a rejected or hanging check frees the button with a visible failure (#708 AC2b).
            settleWithTimeout(() => confirmAddressAction({
              line1,
              line2: line2 || null,
              city,
              state: region,
              zip,
              leaveAtDoor: !handoff && leaveAtDoor,
            }), ADDRESS_TIMEOUT_MS).then((settled) => {
              setConfirming(false);
              if (!settled.ok) {
                setConfirmed(null);
                fail(
                  "address",
                  fulfillment === "ship"
                    ? "We couldn't check that shipping address. Try again."
                    : "We couldn't check that address. Try again.",
                );
                return;
              }
              const result = settled.value;
              if (!result.ok) {
                setConfirmed(null);
                fail("address", result.error);
                return;
              }
              setIssue(null);
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
          frozen={handoff}
          shipping={fulfillment === "ship"}
          onEdit={() => {
            setConfirmed(null);
            setSuggestions([]);
          }}
        />
      }
      contact={contact}
      setContact={setContact}
      whatsapp={stripeConfig.whatsappUpdates ? { checked: whatsappUpdates, onChange: setWhatsappUpdates } : undefined}
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
      setSchedule={chosenByShopper(setSchedule)}
      slot={chosenSlot}
      setSlot={chosenByShopper(setSlot)}
      slots={slots}
      slotRequired={slotRequired}
      promo=""
      setPromo={() => {}}
      appliedPromo=""
      setAppliedPromo={() => {}}
      promoMessage=""
      setPromoMessage={() => {}}
      coupon={{ apply: applyCoupon, remove: removeCoupon }}
      tipPercent={0}
      setTipPercent={() => {}}
      customTip=""
      setCustomTip={() => {}}
      quote={quote}
      quotePending={quotePending}
      quoteFailed={quoteFailed}
      quoteFailMessage={quoteFailMessage}
      onRetryQuote={retryQuote}
      issue={issue}
      onClearIssue={() => setIssue(null)}
      onUseAnotherCard={switchCard}
      onRefresh={refreshCheckout}
      submitAttempt={submitAttempt}
      errorHref={errorHref}
      submitted={submitted}
      payState={payState}
      frozen={frozen}
      hot={hot}
      prepMinutes={slotOptions?.prepMinutes}
      cateringLead={slotOptions?.leadMinutes ? slotOptions.leadMinutes / 60 : undefined}
      weightG={weightG}
      courierEligible={settings.courierOffered}
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
      payLabel={placeOrderLabel(quote)}
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
  const { lines, subtotal, loading, loadFailed, refreshCart } = useCart();

  // Loading, failed and empty are three different states, never one "empty" (#708 P1).
  if (!ready || (loading && !lines.length)) return <FlowLoading />;
  if (!lines.length && loadFailed)
    return (
      <div className={styles.page}>
        <FlowHeading title="Checkout" />
        <EmptyState title="We couldn’t load your basket" description="Check your connection, then try again.">
          <Button type="button" onClick={() => void refreshCart()}>Retry</Button>
        </EmptyState>
      </div>
    );
  if (!lines.length)
    return (
      <div className={styles.page}>
        <FlowHeading title="Checkout" />
        <EmptyState title="Your basket is empty" description="Add your favorites before checking out.">
          <Link href="/categories" className="sf-button">Browse aisles</Link>
        </EmptyState>
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

const DARK_QUERY = "(prefers-color-scheme: dark)";

// Stripe renders in an iframe, so it needs the store's resolved colors, not CSS variables.
function readStoreStripeAppearance(): Appearance {
  const dark = window.matchMedia(DARK_QUERY).matches;
  const css = getComputedStyle(document.body);
  const token = (name: string) => css.getPropertyValue(`--color-${name}`).trim();
  return {
    theme: dark ? "night" : "stripe",
    variables: {
      colorPrimary: token("primary-text"),
      colorBackground: token("surface"),
      colorText: token("ink"),
      colorTextSecondary: token("muted"),
      borderRadius: "8px",
    },
    rules: {
      ".Label": { color: token("ink") },
      ...(dark ? { ".Input": { borderColor: token("line-strong") } } : {}),
    },
  };
}

function useStoreStripeAppearance(): Appearance {
  const [appearance, setAppearance] = useState(readStoreStripeAppearance);
  useEffect(() => {
    const query = window.matchMedia(DARK_QUERY);
    const update = () => setAppearance(readStoreStripeAppearance());
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return appearance;
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
  const appearance = useStoreStripeAppearance();
  return (
    <Elements
      stripe={stripePromise}
      options={{
        mode: "payment",
        amount,
        currency: "usd",
        captureMethod: "manual",
        onBehalfOf: config.onBehalfOf,
        appearance,
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
  /** Present only when the store has a registered WhatsApp number (#560). */
  whatsapp?: { checked: boolean; onChange: (checked: boolean) => void };
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
  /** Store delivery with a schedule: no ASAP, the order takes a slot (#565). */
  slotRequired?: boolean;
  /** A catering basket's lead in hours (#571). */
  cateringLead?: number;
  promo: string;
  setPromo: (v: string) => void;
  appliedPromo: string;
  setAppliedPromo: (v: string) => void;
  promoMessage: string;
  setPromoMessage: (v: string) => void;
  /** Real checkout: the cart's store coupon, put on and taken off on the server (#557). */
  coupon?: {
    apply: (code: string) => Promise<{ ok: true } | { ok: false; error: string }>;
    remove: () => Promise<void>;
  };
  tipPercent: number | null;
  setTipPercent: (v: number | null) => void;
  customTip: string;
  setCustomTip: (v: string) => void;
  quote: CheckoutQuote | null;
  quotePending: boolean;
  /** Real checkout: the quote refused, rejected or timed out, so it offers Retry (#708 AC2b). */
  quoteFailed?: boolean;
  /** The server's reason for refusing the estimate, shown in its Retry box. */
  quoteFailMessage?: string;
  onRetryQuote?: () => void;
  /** The failure of the last Pay, placed beside the control it concerns (#717 AC3). */
  issue: CheckoutIssue | null;
  onClearIssue: () => void;
  onUseAnotherCard?: () => void;
  onRefresh?: () => void;
  /** Bumped on every Pay, so focus moves to the first invalid field or the failure once per attempt. */
  submitAttempt: number;
  errorHref?: string | null;
  submitted: boolean;
  payState: "idle" | "pending" | "success";
  signedIn?: boolean;
  identityLocked?: boolean;
  frozen: boolean;
  /** A hot prepared item is in the basket: no Leave at door (#570). */
  hot?: boolean;
  /** The basket's pickup prep minutes, when the server sent them (#570). */
  prepMinutes?: number;
  weightG: number;
  courierEligible: boolean;
  onSubmit: (e: FormEvent) => void;
  paymentSection: React.ReactNode;
  payLabel: string;
  isRealPayment: boolean;
  outcomeSelector?: React.ReactNode;
  deliveryEditor?: React.ReactNode;
}

/** Handling plus carrier transit, in business days (#567). */
function shipArrival(rate: NonNullable<CheckoutQuote["shipping"]>): string {
  const pack = `${rate.handlingDays} business ${rate.handlingDays === 1 ? "day" : "days"}`;
  if (rate.days == null) return `Packed within ${pack}, then on its way with ${rate.carrier}.`;
  const total = rate.handlingDays + rate.days;
  return `Arrives in about ${total} business days: packed within ${pack}, then ${rate.days} in transit.`;
}

function ShipRate({ rate }: { rate: NonNullable<CheckoutQuote["shipping"]> }) {
  return (
    <div className={styles.shipRate} role="status">
      <Package size={20} aria-hidden />
      <div>
        <p className={styles.shipRateTitle}>
          <span>{rate.carrier} {rate.service}</span>
          <strong>{money(rate.feeCents)}</strong>
        </p>
        <p>{shipArrival(rate)}</p>
        <p>This is the carrier&rsquo;s own rate, with no markup.</p>
      </div>
    </div>
  );
}

function CheckoutLayout(props: CheckoutLayoutProps) {
  const {
    settings, lines, fulfillment, setFulfillment,
    contact, setContact, address, setAddress, query, setQuery,
    suggestions, setSuggestions, searching, notes, setNotes,
    leaveAtDoor, setLeaveAtDoor, schedule, setSchedule,
    slot, setSlot, slots, slotRequired = false, cateringLead, promo, setPromo,
    setAppliedPromo, promoMessage, setPromoMessage, coupon,
    tipPercent, setTipPercent, customTip, setCustomTip,
    quote, quotePending, quoteFailed = false, quoteFailMessage, onRetryQuote,
    issue, onClearIssue, onUseAnotherCard, onRefresh, submitAttempt, errorHref, submitted, payState,
    frozen, hot = false, prepMinutes, weightG, courierEligible,
    onSubmit, paymentSection, payLabel, isRealPayment, outcomeSelector, deliveryEditor,
    signedIn = false, identityLocked = false, whatsapp,
  } = props;
  const itemCount = lines.reduce((sum, l) => sum + l.quantity, 0);

  // Field validity, shared by aria-invalid and the error each field describes (#708 AC3).
  const fieldErrors = submitted ? contactErrors(contact) : {};
  const nameInvalid = Boolean(fieldErrors.name);
  const phoneInvalid = Boolean(fieldErrors.phone);
  const emailInvalid = Boolean(fieldErrors.email);

  // Basket problems the live estimate or the basket itself already knows: Pay stays off, with the reason beside the lines.
  const blocking = checkoutBasketBlock(quote && !quotePending ? quote.problems : null, lines);
  const basketIssue = issue?.section === "basket" ? issue : blocking;
  const flagged = new Set(basketIssue ? [...basketIssue.lineKeys, ...flaggedLineKeys(lines)] : []);
  const issueId = (section: IssueSection) => `checkout-issue-${section}`;

  const formRef = useRef<HTMLFormElement>(null);
  const handledAttempt = useRef(0);
  useEffect(() => {
    // Runs once Pay settles: the fieldset is disabled while pending, so nothing inside could take focus earlier.
    if (payState !== "idle" || submitAttempt === handledAttempt.current) return;
    handledAttempt.current = submitAttempt;
    // Page order: an address problem sits above the contact fields, everything else below them.
    const field = firstInvalidContactField(contact);
    const target = issue?.section === "address"
      ? document.getElementById(issueId("address"))
      : field
        ? document.getElementById(`checkout-contact-${field}`)
        : issue
          ? document.getElementById(issueId(issue.section))
          : null;
    if (!target) return;
    target.scrollIntoView({ block: "center" });
    target.focus({ preventScroll: true });
  }, [submitAttempt, payState, contact, issue]);

  const actions: IssueActions = {
    useAnotherCard: onUseAnotherCard,
    refresh: onRefresh,
    retry: () => formRef.current?.requestSubmit(),
    editAddress: fulfillment === "pickup" ? undefined : () => {
      onClearIssue();
      document.querySelector<HTMLElement>("#fulfillment input:not([disabled])")?.focus();
    },
    choosePickup: settings.pickupEnabled && fulfillment !== "pickup" ? () => {
      onClearIssue();
      setFulfillment("pickup");
    } : undefined,
  };
  const issueHere = (section: IssueSection) =>
    issue?.section === section ? <CheckoutIssueAlert issue={issue} id={issueId(section)} actions={actions} /> : null;

  const courierReasons = (quote?.problems ?? [])
    .filter((problem) => problem.code === "ineligible" || problem.code === "outside-radius")
    .map((problem) => problem.message);
  const courierQuoted = Boolean(quote?.courierProvider) && !quotePending;
  const shipping = fulfillment === "ship";
  const shipRate = shipping && !quotePending ? quote?.shipping ?? null : null;

  return (
    <div className={styles.page}>
      <FlowHeading
        title="A little closer to home"
        description="Review your order and choose how it reaches you."
        backHref="/cart"
        backLabel="Back to basket"
      />
      {!isRealPayment && <DemoNotice />}
      <CheckoutStages />
      <form ref={formRef} className={styles.layout} onSubmit={onSubmit} noValidate>
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
                {isRealPayment && courierEligible && (
                  <Chip
                    type="button"
                    selected={fulfillment === "courier"}
                    onClick={() => setFulfillment("courier")}
                  >
                    <Truck size={18} />
                    {fulfillment === "courier" && courierQuoted && quote
                      ? `Courier · ${money(quote.courierFeeCents)}`
                      : "Courier"}
                  </Chip>
                )}
                {isRealPayment && settings.shippingOffered && (
                  <Chip
                    type="button"
                    selected={shipping}
                    onClick={() => setFulfillment("ship")}
                  >
                    <Package size={18} />
                    {shipRate ? `Ship · ${money(shipRate.feeCents)}` : "Ship"}
                  </Chip>
                )}
              </div>
              <p className={styles.muted}>
                {shipping
                  ? `Order weight: ${(weightG / 453.592).toFixed(1)} lb. Shipped orders can weigh up to 50 lb.`
                  : `Order weight: ${(weightG / 453.592).toFixed(1)} lb. Delivery radius: ${settings.deliveryRadiusMi} miles.`}
              </p>
              {!isRealPayment && !courierEligible && (
                <p className={styles.error}>
                  Courier is unavailable: orders and individual items must be 50
                  lb or less; frozen goods also require confirmed insulated
                  packaging. Choose pickup or store delivery.
                </p>
              )}
              {isRealPayment && fulfillment === "courier" && (
                courierQuoted && quote ? (
                  <p className={styles.muted} role="status">
                    Delivered by {quote.courierProvider === "Uber Direct" ? "Uber" : "DoorDash"}. You pay the
                    courier&rsquo;s own quote, with no markup.
                  </p>
                ) : courierReasons.length > 0 ? (
                  <p className={styles.error} role="status">{courierReasons.join(" ")}</p>
                ) : null
              )}
              {frozen && !shipping && (
                <p className={styles.notice}>
                  Frozen food needs a hand-to-hand delivery. Leave at door is
                  unavailable.
                </p>
              )}
              {hot && !frozen && fulfillment !== "pickup" && !shipping && (
                <p className={styles.notice}>
                  Hot food is handed to you. Leave at door is unavailable.
                </p>
              )}
              {fulfillment === "pickup" ? (
                <AddressCard
                  address={settings.address}
                  title="Collect from the market"
                  demo={!isRealPayment}
                />
              ) : deliveryEditor ? (
                <>
                  {/* Above the form: a basket that cannot ship says so before any typing. */}
                  {shipping && !shipRate && courierReasons.length > 0 && !quotePending && (
                    <p className={styles.shipNote} role="status">
                      <CircleAlert size={18} aria-hidden />
                      {courierReasons.join(" ")}
                    </p>
                  )}
                  {deliveryEditor}
                  {shipRate && <ShipRate rate={shipRate} />}
                </>
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
                      checked={!(frozen || hot) && leaveAtDoor}
                      disabled={frozen || hot}
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
              {issueHere("address")}
            </FlowCard>
          </div>
          <FlowCard title={shipping ? "Notes for the store" : "When works for you?"}>
            {settings.closed && !shipping && (
              <div className={styles.queueNotice}>
                <Clock size={18} aria-hidden />
                <p>
                  <strong>
                    <span>Opens {settings.opensAt} ·</span>{" "}
                    <span>ready about {settings.readyAt}</span>
                  </strong>
                  The store is closed. Order now to join the queue.
                </p>
              </div>
            )}
            {!slotRequired && !shipping && (
              <div className={styles.options}>
                <Chip
                  type="button"
                  selected={!schedule}
                  onClick={() => setSchedule(false)}
                >
                  {settings.closed
                    ? "When the store opens"
                    : `ASAP · about ${prepMinutes ?? settings.prepTimeMinutes} min`}
                </Chip>
                {fulfillment === "pickup" && slots.length > 0 && (
                  <Chip
                    type="button"
                    selected={schedule}
                    onClick={() => { setSchedule(true); setSlot(slots[0].value); }}
                  >
                    Schedule pickup
                  </Chip>
                )}
              </div>
            )}
            {slotRequired && slots.length === 0 && (
              <p className={styles.error} role="status">
                {cateringLead
                  ? `Your catering items need ${cateringLeadText(cateringLead)} notice. This store has no ${fulfillment === "pickup" ? "pickup" : "delivery"} times for that here. Try ${fulfillment === "pickup" ? "delivery" : "pickup"}, or contact the store.`
                  : "No delivery times are open right now. Choose pickup, or check back later."}
              </p>
            )}
            {cateringLead && slots.length > 0 && (
              <p className={styles.muted}>Your catering items need {cateringLeadText(cateringLead)} notice, so times start then.</p>
            )}
            {((schedule && fulfillment === "pickup") || slotRequired) && slots.length > 0 && (
              <label className={styles.field}>
                {fulfillment === "pickup" ? "Pickup time" : "Delivery time"}
                <select value={slot} onChange={(e) => setSlot(e.target.value)}>
                  {slots.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <small>Times are in the store&apos;s timezone.</small>
              </label>
            )}
            <label className={styles.field}>
              Order notes (optional)
              <textarea
                value={notes}
                maxLength={1000}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={fulfillment === "pickup" || shipping ? "A note for your shopper" : "Apartment, gate code, or a note for your shopper"}
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
                  id="checkout-contact-name"
                  autoComplete="name"
                  required
                  readOnly={identityLocked}
                  value={contact.name}
                  aria-invalid={nameInvalid}
                  aria-describedby={nameInvalid ? "contact-name-error" : undefined}
                  onChange={(e) => setContact({ ...contact, name: e.target.value })}
                />
              </label>
              {nameInvalid && (
                <p className={styles.error} id="contact-name-error">{fieldErrors.name}</p>
              )}
              <label className={styles.field}>
                Phone number (required)
                <input
                  id="checkout-contact-phone"
                  autoComplete="tel"
                  type="tel"
                  required
                  value={contact.phone}
                  aria-invalid={phoneInvalid}
                  aria-describedby={phoneInvalid ? "contact-phone-error" : undefined}
                  onChange={(e) => setContact({ ...contact, phone: e.target.value })}
                  placeholder="(555) 123-4567"
                />
              </label>
              {phoneInvalid && (
                <p className={styles.error} id="contact-phone-error">{fieldErrors.phone}</p>
              )}
              {whatsapp && (
                <label className={styles.choice}>
                  <input
                    type="checkbox"
                    checked={whatsapp.checked}
                    onChange={(event) => whatsapp.onChange(event.target.checked)}
                  />
                  <span>
                    Get order updates on WhatsApp
                    <small>Instead of texts, from {settings.name}. Reply STOP to turn them off.</small>
                  </span>
                </label>
              )}
              <label className={styles.field}>
                Email (required)
                <input
                  id="checkout-contact-email"
                  autoComplete="email"
                  type="email"
                  required
                  readOnly={identityLocked}
                  value={contact.email}
                  aria-invalid={emailInvalid}
                  aria-describedby={emailInvalid ? "contact-email-error" : undefined}
                  onChange={(e) => setContact({ ...contact, email: e.target.value })}
                />
              </label>
              {emailInvalid && (
                <p className={styles.error} id="contact-email-error">{fieldErrors.email}</p>
              )}
            </FlowCard>
          </div>
          {fulfillment !== "pickup" && !shipping && (
            <FlowCard title="A thank-you for your driver">
              <p className={styles.muted}>
                100% of your tip goes to the courier. No tip is added unless
                you choose one.
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
              {issueHere("payment")}
              {outcomeSelector}
            </FlowCard>
          </div>
        </fieldset>
        <aside id="review" className={`${styles.sticky} ${styles.anchor}`}>
          <FlowCard title="Your order">
            <p className={styles.muted}>
              {settings.name} · {itemCount} {itemCount === 1 ? "item" : "items"}{" "}
              <Link className="sf-text-link" href="/cart">Edit basket</Link>
            </p>
            <ul className={styles.miniLines}>
              {lines.map((line) => {
                const problem = flagged.has(cartItemKey(line));
                return (
                  <li
                    key={cartItemKey(line)}
                    data-problem={problem || undefined}
                    aria-describedby={problem && basketIssue ? issueId("basket") : undefined}
                  >
                    <span>{line.quantity} × {line.name}</span>
                    <span>{money(line.quantity * line.price)}</span>
                    {problem && (
                      <small className={styles.miniLineProblem}>
                        <CircleAlert size={14} aria-hidden />
                        {line.available === false
                          ? "No longer available"
                          : line.maxPerOrder !== undefined && line.quantity > line.maxPerOrder
                            ? `Limit ${line.maxPerOrder} per order`
                            : "Needs a change"}
                      </small>
                    )}
                  </li>
                );
              })}
            </ul>
            {basketIssue && <CheckoutIssueAlert issue={basketIssue} id={issueId("basket")} actions={actions} />}
            {coupon ? (
              <CouponField
                applied={quote?.coupon ?? null}
                apply={coupon.apply}
                remove={coupon.remove}
                disabled={payState !== "idle"}
              />
            ) : (
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
              <QuoteLines quote={quote} fulfillment={fulfillment} />
            ) : quoteFailed ? null : (
              <p role="status">Estimating your order…</p>
            )}
            <p className={styles.notice}>
              {quote && <>Your card will be authorized for {money(quote.holdCents)}. </>}
              We authorize the estimated total plus a 10% buffer, capped at $20.
              You&rsquo;ll be charged the final amount after picking; unused
              funds are released. Any higher-priced swap requires your approval
              and must fit within this hold.
            </p>
            {quoteFailed && onRetryQuote ? (
              <div className={styles.quoteRetry} role="alert">
                <p>{quoteFailMessage ?? "We couldn\u2019t update your estimate. Check your connection, then try again."}</p>
                <Button type="button" onClick={onRetryQuote}>Retry estimate</Button>
              </div>
            ) : quotePending ? (
              <p className={styles.muted} role="status">Updating estimate…</p>
            ) : null}
            {issueHere("session")}
            {issueHere("network")}
            {issue?.section === "general" && (
              <FlowError title="Let's review that" message={issue.message}>
                {errorHref ? <Link className="sf-text-link" href={errorHref}>View your orders</Link> : null}
              </FlowError>
            )}
            {isRealPayment && settings.closed && (
              <p className={styles.muted}>
                The store opens {settings.opensAt}. Your card is held now and
                charged after picking. If the store doesn&rsquo;t accept your
                order, the hold is released.
              </p>
            )}
            {quote && (
              <p className={styles.payTotal}>
                <span>Estimated total</span>
                <strong>{money(quote.totalCents)}</strong>
              </p>
            )}
            <PayButton
              type="submit"
              state={payState}
              realPayment={isRealPayment}
              disabled={payState !== "idle" || quotePending || Boolean(blocking)}
              aria-describedby={blocking ? issueId("basket") : undefined}
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
  const [tipPercent, setTipPercent] = useState<number | null>(0);
  const [customTip, setCustomTip] = useState("");
  const [quote, setQuote] = useState<CheckoutQuote | null>(null);
  const [quoteKey, setQuoteKey] = useState("");
  const [issue, setIssue] = useState<CheckoutIssue | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submitAttempt, setSubmitAttempt] = useState(0);
  const [refreshNonce, setRefreshNonce] = useState(0);
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
  const tipCents = fulfillment === "pickup"
    ? 0
    : tipPercent === null
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
      if (active) setIssue(issueFromError(reason, "Could not estimate your order."));
    });
    return () => { active = false; };
    // refreshNonce re-asks the same quote for Refresh checkout.
  }, [services, input, refreshNonce]);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      if (query.trim().length < 3) { setSuggestions([]); return; }
      setSearching(true);
      services.addresses.search(query)
        .then((results) => { if (active) setSuggestions(results); })
        .catch(() => { if (active) setIssue({ section: "address", message: "Address lookup is unavailable.", lineKeys: [] }); })
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
    if (payState !== "idle") return;
    setSubmitted(true);
    setSubmitAttempt((attempt) => attempt + 1);
    setIssue(null);
    if (firstInvalidContactField(contact)) return;
    if (schedule && slot === "asap") {
      setIssue({ section: "general", message: "Choose a pickup time within the next six days.", lineKeys: [] });
      return;
    }
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
      if (latest.problems.length) {
        // The simulated unavailable line stands in for the shopper's first line.
        const stand = cartItemKey(request.lines[0] ?? input.lines[0]);
        const own = input.lines[0] ? cartItemKey(input.lines[0]) : stand;
        const placed = issueFromProblems(latest.problems.map((p) => (p.lineKey === stand ? { ...p, lineKey: own } : p)));
        setIssue(placed ?? { section: "general", message: [...new Set(latest.problems.map((p) => p.message))].join(" "), lineKeys: [] });
        setPayState("idle");
        return;
      }
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
      setIssue(issueFromError(reason, "We could not place your demo order."));
      setPayState("idle");
    }
  }

  if (!ready) return <FlowLoading />;
  if (!lines.length && payState !== "success")
    return (
      <div className={styles.page}>
        <FlowHeading title="Checkout" />
        <EmptyState title="Your basket is empty" description="Add your favorites before checking out.">
          <Link href="/categories" className="sf-button">Browse aisles</Link>
        </EmptyState>
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
      issue={issue}
      onClearIssue={() => setIssue(null)}
      onUseAnotherCard={() => {
        setIssue(null);
        focusPaymentEntry();
      }}
      onRefresh={() => {
        setIssue(null);
        setRefreshNonce((nonce) => nonce + 1);
        void refreshCart();
      }}
      submitAttempt={submitAttempt}
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

const STAGES = [
  { id: "fulfillment", label: "1. Fulfillment" },
  { id: "contact", label: "2. Contact" },
  { id: "payment", label: "3. Payment" },
  { id: "review", label: "4. Review" },
] as const;

/** Section links that mark where the shopper is with aria-current="step". */
function CheckoutStages() {
  const [current, setCurrent] = useState<string>(STAGES[0].id);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const sections = STAGES.flatMap(({ id }) => {
        const node = document.getElementById(id);
        return node ? [{ id, top: node.getBoundingClientRect().top }] : [];
      });
      // Below the sticky header, about 40% down the viewport.
      const next = activeSection(sections, Math.max(180, window.innerHeight * 0.4));
      if (next) setCurrent(next);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);
  return (
    <nav className={styles.stages} aria-label="Checkout sections">
      {STAGES.map(({ id, label }) => (
        <a key={id} href={`#${id}`} aria-current={current === id ? "step" : undefined}>
          {label}
        </a>
      ))}
    </nav>
  );
}
