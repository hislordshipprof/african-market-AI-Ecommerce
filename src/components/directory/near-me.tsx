"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { LocateFixed } from "lucide-react";
import { NEARBY_MILES } from "@/lib/directory/distance";
import { StoreCard, type CardStore } from "./store-card";
import styles from "./directory.module.css";

export type StateGroup = { code: string; name: string; stores: { slug: string; name: string; city: string | null; href: string }[] };

type Answer =
  | { kind: "stores"; label: string | null; nearby: boolean; stores: CardStore[] }
  | { kind: "ambiguous"; name: string; states: string[] }
  | { kind: "none" }
  | { kind: "outside" };

type View =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "message"; text: string }
  | Answer;

const DENIED = "Location is off for this site. Enter your ZIP code or city instead.";
const UNAVAILABLE = "We couldn't get your location. Enter your ZIP code or city instead.";

/** Store directory near me (#452). Location is asked for only when the shopper taps the button. */
export function NearMe({ states, children }: { states: StateGroup[]; children: ReactNode }) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>({ kind: "idle" });
  const input = useRef<HTMLInputElement>(null);

  async function search(params: URLSearchParams) {
    setView({ kind: "busy" });
    try {
      const res = await fetch(`/api/directory/near?${params}`);
      const body = await res.json();
      setView(res.ok ? (body as Answer) : { kind: "message", text: body.error ?? UNAVAILABLE });
    } catch {
      setView({ kind: "message", text: "Search isn't working right now. Try again in a moment." });
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void search(new URLSearchParams({ q: query }));
  }

  function fallBackToZip(text: string) {
    setView({ kind: "message", text });
    input.current?.focus();
  }

  function locateMe() {
    if (!("geolocation" in navigator)) return fallBackToZip(UNAVAILABLE);
    setView({ kind: "busy" });
    navigator.geolocation.getCurrentPosition(
      // Rounded to about 100 m: enough to rank stores, no more precise than needed.
      ({ coords }) => void search(new URLSearchParams({ lat: coords.latitude.toFixed(3), lng: coords.longitude.toFixed(3) })),
      (error) => fallBackToZip(error.code === error.PERMISSION_DENIED ? DENIED : UNAVAILABLE),
      { maximumAge: 600_000, timeout: 15_000 },
    );
  }

  function pickState(code: string) {
    if (view.kind !== "ambiguous") return;
    const next = `${view.name}, ${code}`;
    setQuery(next);
    void search(new URLSearchParams({ q: next }));
  }

  return (
    <>
      <form className={styles.search} onSubmit={onSubmit} role="search" aria-label="Find stores near you">
        <label className={styles.searchLabel} htmlFor="near-query">ZIP code or city</label>
        <div className={styles.searchRow}>
          <input
            ref={input}
            id="near-query"
            className={styles.searchInput}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="77002 or Houston, TX"
            maxLength={80}
            autoComplete="postal-code"
            required
          />
          <button type="submit" className={styles.searchButton} disabled={view.kind === "busy"}>Find stores</button>
        </div>
        <button type="button" className={styles.locate} onClick={locateMe} disabled={view.kind === "busy"}>
          <LocateFixed aria-hidden="true" size={16} />
          Use my location
        </button>
      </form>

      <div aria-live="polite" className={styles.status}>
        {view.kind === "busy" ? <p className={styles.note}>Finding stores…</p> : null}
        {view.kind === "message" ? <p className={styles.note}>{view.text}</p> : null}
        {view.kind === "none" ? <p className={styles.note}>We don&apos;t have that ZIP code or city on our map. Some ZIP codes, like PO boxes, aren&apos;t on it: try your city, or add the state.</p> : null}
        {view.kind === "outside" ? <p className={styles.note}>You look to be outside the US. Our stores are all in the US: browse them by state below.</p> : null}
        {view.kind === "ambiguous" ? (
          <div className={styles.choice}>
            <p className={styles.note}>There is a {view.name} in {view.states.length} states. Which one?</p>
            <ul className={styles.choices}>
              {view.states.map((code) => (
                <li key={code}>
                  <button type="button" className={styles.choiceButton} onClick={() => pickState(code)}>{view.name}, {code}</button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {view.kind === "stores" ? <Results answer={view} /> : null}
      {view.kind === "outside" || (view.kind === "stores" && !view.nearby) ? <StateList states={states} /> : null}
      {view.kind === "stores" || view.kind === "outside" ? null : children}
    </>
  );
}

function Results({ answer }: { answer: Extract<Answer, { kind: "stores" }> }) {
  const place = answer.label ?? "you";
  const heading = answer.stores.length === 0
    ? "No stores are listed yet"
    : answer.nearby
      ? `Stores near ${place}`
      : `No stores within ${NEARBY_MILES} miles of ${place}`;
  return (
    <section aria-labelledby="near-results" className={styles.results}>
      <h2 id="near-results" className={styles.resultsTitle}>{heading}</h2>
      {!answer.nearby && answer.stores.length > 0 ? <p className={styles.note}>These are the closest stores.</p> : null}
      <ul className={styles.grid}>
        {answer.stores.map((store) => (
          <li key={store.slug}><StoreCard store={store} /></li>
        ))}
      </ul>
    </section>
  );
}

function StateList({ states }: { states: StateGroup[] }) {
  return (
    <section aria-labelledby="by-state" className={styles.results}>
      <h2 id="by-state" className={styles.resultsTitle}>Browse by state</h2>
      <ul className={styles.states}>
        {states.map((state) => (
          <li key={state.code} className={styles.state}>
            <h3 className={styles.stateName}>{state.name}</h3>
            <ul className={styles.stateStores}>
              {state.stores.map((store) => (
                <li key={store.slug}>
                  <a href={store.href} className={styles.stateStore}>{store.name}</a>
                  {store.city ? <span className={styles.place}>{store.city}</span> : null}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
