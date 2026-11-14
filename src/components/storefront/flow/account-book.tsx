"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { USPS_STATE_CODES } from "@/lib/customer-account/address-validation";
import {
  addAddressAction,
  editAddressAction,
  removeAddressAction,
  removeCardAction,
  setDefaultAddressAction,
} from "@/lib/customer-account/actions";
import type { AccountBookSnapshot, AccountAddressView } from "@/lib/customer-account/checkout-profile";
import type { AccountCard } from "@/lib/customer-account/saved-cards";
import { Button } from "../primitives";
import { FlowCard } from "./common";

const EMPTY = {
  label: "",
  line1: "",
  line2: "",
  city: "",
  state: "MD",
  zip: "",
  notes: "",
};

type FormState = typeof EMPTY;

function fromAddress(address: AccountAddressView): FormState {
  return {
    label: address.label,
    line1: address.line1,
    line2: address.line2 ?? "",
    city: address.city,
    state: address.state,
    zip: address.zip,
    notes: address.notes ?? "",
  };
}

export function RealAccountBook({ initial }: { initial: AccountBookSnapshot }) {
  // Each save refreshes the router, or Back restores a cached page from before it.
  const router = useRouter();
  const [addresses, setAddresses] = useState(initial.addresses);
  const [cards, setCards] = useState(initial.cards);
  const [cardsUnavailable, setCardsUnavailable] = useState(initial.cardsUnavailable);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function setField(key: keyof FormState, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submitAddress(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const payload = {
      label: form.label,
      line1: form.line1,
      line2: form.line2,
      city: form.city,
      state: form.state,
      zip: form.zip,
      notes: form.notes,
    };
    const result = editingId
      ? await editAddressAction(editingId, payload)
      : await addAddressAction(payload);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setAddresses(result.addresses);
    setForm(EMPTY);
    setEditingId(null);
    router.refresh();
  }

  async function run(task: () => Promise<{ ok: true; addresses: AccountAddressView[] } | { ok: false; error: string }>) {
    setBusy(true);
    setError("");
    const result = await task();
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setAddresses(result.addresses);
    router.refresh();
  }

  async function removeCard(card: AccountCard) {
    setBusy(true);
    setError("");
    const result = await removeCardAction(card.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setCards(result.cards);
    setCardsUnavailable(result.unavailable);
    router.refresh();
  }

  return (
    <FlowCard title="Saved addresses">
      <div className="sf-account-list" data-testid="account-address-list">
        {addresses.map((address) => (
          <article className="sf-account-address" key={address.id}>
            <p>
              <strong>{address.label}</strong>
              {address.isDefault ? <span className="sf-account-default">Default</span> : null}
            </p>
            <p>
              {address.line1}
              {address.line2 ? `, ${address.line2}` : ""}
            </p>
            <p>
              {address.city}, {address.state} {address.zip}
            </p>
            {address.notes ? <p>{address.notes}</p> : null}
            <div className="sf-account-actions">
              <button
                type="button"
                className="sf-text-link"
                onClick={() => {
                  setEditingId(address.id);
                  setForm(fromAddress(address));
                  setError("");
                }}
              >
                Edit
              </button>
              {!address.isDefault ? (
                <button
                  type="button"
                  className="sf-text-link"
                  onClick={() => void run(() => setDefaultAddressAction(address.id))}
                >
                  Set as default
                </button>
              ) : null}
              <button
                type="button"
                className="sf-text-link"
                onClick={() => void run(() => removeAddressAction(address.id))}
              >
                Remove
              </button>
            </div>
          </article>
        ))}
        {addresses.length === 0 ? <p>No saved addresses yet.</p> : null}
      </div>
      <form className="sf-account-form" data-testid="account-address-form" onSubmit={submitAddress}>
        <p>{editingId ? "Edit address" : "Add an address"}</p>
        <label>
          Label
          <input
            required
            name="label"
            autoComplete="off"
            value={form.label}
            onChange={(event) => setField("label", event.target.value)}
            placeholder="Label, such as Home"
          />
        </label>
        <label>
          Street
          <input
            required
            name="line1"
            autoComplete="address-line1"
            value={form.line1}
            onChange={(event) => setField("line1", event.target.value)}
          />
        </label>
        <label>
          Apartment, suite (optional)
          <input
            name="line2"
            autoComplete="address-line2"
            value={form.line2}
            onChange={(event) => setField("line2", event.target.value)}
          />
        </label>
        <label>
          City
          <input
            required
            name="city"
            autoComplete="address-level2"
            value={form.city}
            onChange={(event) => setField("city", event.target.value)}
          />
        </label>
        <label>
          State
          <select
            name="state"
            autoComplete="address-level1"
            value={form.state}
            onChange={(event) => setField("state", event.target.value)}
          >
            {USPS_STATE_CODES.map((code) => (
              <option key={code} value={code}>{code}</option>
            ))}
          </select>
        </label>
        <label>
          ZIP
          <input
            required
            name="zip"
            autoComplete="postal-code"
            inputMode="numeric"
            value={form.zip}
            onChange={(event) => setField("zip", event.target.value)}
          />
        </label>
        <label>
          Delivery notes (optional)
          <input
            name="notes"
            value={form.notes}
            onChange={(event) => setField("notes", event.target.value)}
          />
        </label>
        {error ? <p role="alert">{error}</p> : null}
        <Button disabled={busy}>{editingId ? "Save address" : "Add address"}</Button>
        {editingId ? (
          <button
            type="button"
            className="sf-text-link"
            onClick={() => {
              setEditingId(null);
              setForm(EMPTY);
              setError("");
            }}
          >
            Cancel edit
          </button>
        ) : null}
      </form>
      <div className="sf-account-cards" data-testid="account-card-list">
        <h3>Saved cards</h3>
        {cardsUnavailable ? <p>Saved cards are unavailable right now</p> : null}
        {!cardsUnavailable && cards.length === 0 ? <p>No saved cards yet.</p> : null}
        {cards.map((card) => (
          <article className="sf-account-address" key={card.id}>
            <p>
              {card.brand} ending in {card.last4}
              {card.expired ? " · Expired" : ""}
              {!card.reusable ? " · Not offered at checkout" : ""}
            </p>
            <p>
              Expires {card.expMonth}/{card.expYear}
            </p>
            <div className="sf-account-actions">
              <button type="button" className="sf-text-link" onClick={() => void removeCard(card)}>
                Remove
              </button>
            </div>
          </article>
        ))}
      </div>
    </FlowCard>
  );
}
