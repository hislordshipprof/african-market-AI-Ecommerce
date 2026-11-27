"use client";

import { useId, useState, type FormEvent } from "react";
import { BellRing } from "lucide-react";
import { requestStoreNotice } from "@/lib/directory/request-actions";
import { STORE_REQUEST_CONSENT } from "@/lib/directory/store-request-consent";
import { TurnstileWidget } from "@/components/turnstile-widget";
import styles from "./directory.module.css";

type State = { kind: "idle" } | { kind: "busy" } | { kind: "error"; text: string } | { kind: "done"; zip: string };

/** "Tell me when a store opens near me" (#455): shown when no store is within 50 miles. */
export function StoreRequestForm({ zip: initialZip, turnstileSiteKey }: { zip: string | null; turnstileSiteKey: string | null }) {
  const id = useId();
  const [zip, setZip] = useState(initialZip ?? "");
  const [contact, setContact] = useState("");
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const [token, setToken] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setState({ kind: "busy" });
    try {
      const result = await requestStoreNotice({ zip, contact, consent, website }, token);
      setState(result.ok ? { kind: "done", zip: zip.trim().slice(0, 5) } : { kind: "error", text: result.message });
    } catch {
      setState({ kind: "error", text: "That didn't go through. Try again in a moment." });
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className={styles.request}>
      <BellRing aria-hidden="true" size={20} className={styles.requestIcon} />
      <div className={styles.requestBody}>
        <h2 id={`${id}-title`} className={styles.requestTitle}>Tell me when a store opens near me</h2>
        {state.kind === "done" ? (
          <p className={styles.requestDone} role="status">
            Thanks. We&apos;ll send you one message when a store opens within 50 miles of {state.zip}.
          </p>
        ) : (
          <form className={styles.requestForm} onSubmit={onSubmit}>
            <p className={styles.note}>One email or text when a store joins near you. Nothing else.</p>
            <div className={styles.requestFields}>
              <div className={styles.requestField}>
                <label htmlFor={`${id}-zip`} className={styles.searchLabel}>ZIP code</label>
                <input
                  id={`${id}-zip`}
                  className={styles.searchInput}
                  value={zip}
                  onChange={(event) => setZip(event.target.value)}
                  inputMode="numeric"
                  autoComplete="postal-code"
                  maxLength={10}
                  required
                />
              </div>
              <div className={styles.requestField}>
                <label htmlFor={`${id}-contact`} className={styles.searchLabel}>Email or mobile number</label>
                <input
                  id={`${id}-contact`}
                  className={styles.searchInput}
                  value={contact}
                  onChange={(event) => setContact(event.target.value)}
                  autoComplete="email"
                  maxLength={254}
                  required
                />
              </div>
            </div>
            {/* Hidden from people; a bot that fills it is dropped. */}
            <div className={styles.honeypot} aria-hidden="true">
              <label htmlFor={`${id}-website`}>Website</label>
              <input id={`${id}-website`} tabIndex={-1} autoComplete="off" value={website} onChange={(event) => setWebsite(event.target.value)} />
            </div>
            <label className={styles.consent}>
              <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} required />
              <span>{STORE_REQUEST_CONSENT}</span>
            </label>
            {turnstileSiteKey && <TurnstileWidget siteKey={turnstileSiteKey} onToken={setToken} resetOn={state} className={styles.turnstile} />}
            <div className={styles.requestActions}>
              <button type="submit" className={styles.searchButton} disabled={state.kind === "busy"}>Notify me</button>
              <p aria-live="polite" className={styles.requestError}>{state.kind === "error" ? state.text : null}</p>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
