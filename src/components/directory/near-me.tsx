"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { Check, LocateFixed } from "lucide-react";
import { directoryLink } from "@/lib/directory/attribution";
import { NEARBY_MILES } from "@/lib/directory/distance";
import { withCuisine, type CuisineChip } from "@/lib/directory/cuisine-filter";
import { StoreCard, type CardStore } from "./store-card";
import { StoreRequestForm } from "./store-request-form";
import styles from "./directory.module.css";

export type StateGroup = { code: string; name: string; href: string; stores: { slug: string; name: string; city: string | null; href: string }[] };

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

/**
 * Store directory near me (#452). Location is asked for only when the shopper taps the button.
 * The home's hero frames the search (#690); a cuisine chip filters the list on show, home or results.
 */
export function NearMe({ states, stores, chips, backdrop, intro, counts }: {
  states: StateGroup[];
  stores: CardStore[];
  chips: CuisineChip[];
  backdrop: ReactNode;
  intro: ReactNode;
  counts: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>({ kind: "idle" });
  const [cuisine, setCuisine] = useState<string | null>(null);
  const chosen = chips.find((chip) => chip.value === cuisine) ?? null;
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
      <section className={styles.hero} aria-labelledby="directory-title">
        {backdrop}
        <div className={styles.heroBody}>
          {intro}
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
          {counts}
        </div>
      </section>

      <div className={styles.section}>
        {view.kind === "outside" ? null : (
          <Browse chips={chips} chosen={chosen} onChoose={(value) => setCuisine((current) => (current === value ? null : value))} />
        )}
        {view.kind === "stores" ? <Results answer={view} cuisine={chosen} /> : null}
        {view.kind === "stores" && !view.nearby ? <StoreRequestForm zip={view.label && /^\d{5}$/.test(view.label) ? view.label : null} /> : null}
        {view.kind === "outside" || (view.kind === "stores" && !view.nearby) ? <StateList states={states} /> : null}
        {view.kind === "stores" || view.kind === "outside" ? null : <AllStores stores={stores} cuisine={chosen} />}
      </div>
    </>
  );
}

/** "Browse by where home is" (#690): one tap filters, a second tap on the same chip clears it. */
function Browse({ chips, chosen, onChoose }: { chips: CuisineChip[]; chosen: CuisineChip | null; onChoose: (value: string) => void }) {
  if (chips.length === 0) return null;
  return (
    <section aria-labelledby="browse-title" className={styles.browse}>
      <h2 id="browse-title" className={styles.sectionTitle}>Browse by where home is</h2>
      <ul className={styles.chips} aria-label="Filter markets by cuisine">
        {chips.map((chip) => {
          const on = chosen?.value === chip.value;
          return (
            <li key={chip.value}>
              <button type="button" className={styles.chip} aria-pressed={on} onClick={() => onChoose(chip.value)}>
                {on ? <Check aria-hidden="true" size={16} strokeWidth={2.25} /> : null}
                {chip.label}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function StoreGrid({ stores }: { stores: CardStore[] }) {
  return (
    <ul className={styles.grid}>
      {stores.map((store) => (
        <li key={store.slug}><StoreCard store={store} /></li>
      ))}
    </ul>
  );
}

/** Said when a chip leaves no store in the list, with the way back. */
function NoneTagged({ cuisine }: { cuisine: CuisineChip }) {
  return <p className={styles.note}>None of these markets list {cuisine.label}. Tap {cuisine.label} again to see them all.</p>;
}

function AllStores({ stores, cuisine }: { stores: CardStore[]; cuisine: CuisineChip | null }) {
  const shown = withCuisine(stores, cuisine?.value ?? null);
  const what = cuisine ? `${cuisine.label} ` : "";
  return (
    <section aria-labelledby="directory-stores" className={styles.results}>
      <h2 id="directory-stores" className={styles.count} aria-live="polite">
        {shown.length === 1 ? `1 ${what}market` : `${shown.length} ${what}markets`}
      </h2>
      {stores.length === 0 ? <p className={styles.empty}>No stores are listed yet. Check back soon.</p> : null}
      {stores.length > 0 && shown.length === 0 && cuisine ? <NoneTagged cuisine={cuisine} /> : null}
      {shown.length > 0 ? <StoreGrid stores={shown} /> : null}
    </section>
  );
}

function Results({ answer, cuisine }: { answer: Extract<Answer, { kind: "stores" }>; cuisine: CuisineChip | null }) {
  const place = answer.label ?? "you";
  const shown = withCuisine(answer.stores, cuisine?.value ?? null);
  const heading = answer.stores.length === 0
    ? "No stores are listed yet"
    : answer.nearby
      ? `Stores near ${place}`
      : `No stores within ${NEARBY_MILES} miles of ${place}`;
  return (
    <section aria-labelledby="near-results" className={styles.results}>
      <h2 id="near-results" className={styles.resultsTitle}>{heading}</h2>
      {!answer.nearby && answer.stores.length > 0 ? <p className={styles.note}>These are the closest stores.</p> : null}
      {answer.stores.length > 0 && shown.length === 0 && cuisine ? <NoneTagged cuisine={cuisine} /> : null}
      {shown.length > 0 ? <StoreGrid stores={shown} /> : null}
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
            <h3 className={styles.stateName}><a href={state.href}>{state.name}</a></h3>
            <ul className={styles.stateStores}>
              {state.stores.map((store) => (
                <li key={store.slug}>
                  <a href={directoryLink(store.href)} className={styles.stateStore}>{store.name}</a>
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
