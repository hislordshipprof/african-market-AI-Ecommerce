"use client";

import { useReducer, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Check, LocateFixed, RotateCw } from "lucide-react";
import { directoryLink } from "@/lib/directory/attribution";
import { NEARBY_MILES } from "@/lib/directory/distance";
import { withCuisine, type CuisineChip } from "@/lib/directory/cuisine-filter";
import { fetchNear, nearSearch, type NearAnswer, type NearState } from "@/lib/directory/near-search";
import { StoreCard, type CardStore } from "./store-card";
import { StoreRequestForm } from "./store-request-form";
import styles from "./directory.module.css";

export type StateGroup = { code: string; name: string; href: string; stores: { slug: string; name: string; city: string | null; href: string }[] };

type Answer = NearAnswer<CardStore>;
type StoresAnswer = Extract<Answer, { kind: "stores" }>;

const IDLE: NearState<CardStore> = { answer: null, pending: false, failure: null };
const DENIED = "Location is off for this site. Enter your ZIP code or city instead.";
const UNAVAILABLE = "We couldn't get your location. Enter your ZIP code or city instead.";

/**
 * Store directory near me (#452). Location is asked for only when the shopper taps the button.
 * The home's hero frames the search (#690); a cuisine chip filters the list on show, home or results.
 * A new or failed search keeps the last results on screen, never the nationwide list (#728).
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
  const [{ answer, pending, failure }, dispatch] = useReducer(nearSearch<CardStore>, IDLE);
  const [cuisine, setCuisine] = useState<string | null>(null);
  const chosen = chips.find((chip) => chip.value === cuisine) ?? null;
  const input = useRef<HTMLInputElement>(null);
  const lastSearch = useRef<URLSearchParams | null>(null);

  async function search(params: URLSearchParams) {
    lastSearch.current = params;
    dispatch({ type: "start" });
    const outcome = await fetchNear<CardStore>(params);
    dispatch(outcome.ok ? { type: "done", answer: outcome.answer } : { type: "failed", text: outcome.text, retry: outcome.retry });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void search(new URLSearchParams({ q: query }));
  }

  function retry() {
    if (lastSearch.current) void search(lastSearch.current);
  }

  function fallBackToZip(text: string) {
    dispatch({ type: "failed", text, retry: false });
    input.current?.focus();
  }

  function locateMe() {
    if (!("geolocation" in navigator)) return fallBackToZip(UNAVAILABLE);
    dispatch({ type: "start" });
    navigator.geolocation.getCurrentPosition(
      // Rounded to about 100 m: enough to rank stores, no more precise than needed.
      ({ coords }) => void search(new URLSearchParams({ lat: coords.latitude.toFixed(3), lng: coords.longitude.toFixed(3) })),
      (error) => fallBackToZip(error.code === error.PERMISSION_DENIED ? DENIED : UNAVAILABLE),
      { maximumAge: 600_000, timeout: 15_000 },
    );
  }

  function pickState(code: string) {
    if (answer?.kind !== "ambiguous") return;
    const next = `${answer.name}, ${code}`;
    setQuery(next);
    void search(new URLSearchParams({ q: next }));
  }

  const toggleCuisine = (value: string) => setCuisine((current) => (current === value ? null : value));
  const clearCuisine = () => setCuisine(null);
  const found = answer?.kind === "stores" ? withCuisine(answer.stores, cuisine).length : null;

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
          <button type="submit" className={styles.searchButton} disabled={pending}>Find stores</button>
        </div>
        <button type="button" className={styles.locate} onClick={locateMe} disabled={pending}>
          <LocateFixed aria-hidden="true" size={16} />
          Use my location
        </button>
      </form>

      <div aria-live="polite" className={styles.status}>
        {pending ? <p className={styles.note}>Finding stores…</p> : null}
        {failure ? (
          <div className={styles.failure}>
            <p className={styles.note}>{failure.text}</p>
            {failure.retry ? (
              <button type="button" className={styles.choiceButton} onClick={retry}>
                <RotateCw aria-hidden="true" size={16} />
                Retry
              </button>
            ) : null}
          </div>
        ) : null}
        {!pending && !failure && found !== null ? <p className={styles.srOnly}>{found === 1 ? "1 store found" : `${found} stores found`}</p> : null}
        {answer?.kind === "none" ? <p className={styles.note}>We don&apos;t have that ZIP code or city on our map. Some ZIP codes, like PO boxes, aren&apos;t on it: try your city, or add the state.</p> : null}
        {answer?.kind === "outside" ? <p className={styles.note}>You look to be outside the US. Our stores are all in the US: browse them by state below.</p> : null}
        {answer?.kind === "ambiguous" ? (
          <div className={styles.choice}>
            <p className={styles.note}>There is a {answer.name} in {answer.states.length} states. Which one?</p>
            <ul className={styles.choices}>
              {answer.states.map((code) => (
                <li key={code}>
                  <button type="button" className={styles.choiceButton} onClick={() => pickState(code)} disabled={pending}>{answer.name}, {code}</button>
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
        {answer?.kind === "outside" ? null : <Browse chips={chips} chosen={chosen} onChoose={toggleCuisine} />}
        {answer?.kind === "stores" ? <Results answer={answer} cuisine={chosen} refreshing={pending} onClear={clearCuisine} /> : null}
        {answer?.kind === "stores" && !answer.nearby ? <StoreRequestForm zip={answer.label && /^\d{5}$/.test(answer.label) ? answer.label : null} /> : null}
        {answer?.kind === "outside" || (answer?.kind === "stores" && !answer.nearby) ? <StateList states={states} /> : null}
        {answer?.kind === "stores" || answer?.kind === "outside" ? null : <AllStores stores={stores} cuisine={chosen} onClear={clearCuisine} />}
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
function NoneTagged({ cuisine, onClear }: { cuisine: CuisineChip; onClear: () => void }) {
  return (
    <div className={styles.noneTagged}>
      <p className={styles.note}>None of these markets list {cuisine.label}.</p>
      <button type="button" className={styles.choiceButton} onClick={onClear}>Clear filter</button>
    </div>
  );
}

function AllStores({ stores, cuisine, onClear }: { stores: CardStore[]; cuisine: CuisineChip | null; onClear: () => void }) {
  const shown = withCuisine(stores, cuisine?.value ?? null);
  const what = cuisine ? `${cuisine.label} ` : "";
  return (
    <section aria-labelledby="directory-stores" className={styles.results}>
      <h2 id="directory-stores" className={styles.count} aria-live="polite">
        {stores.length === 0 ? "No stores are listed yet" : shown.length === 1 ? `1 ${what}market` : `${shown.length} ${what}markets`}
      </h2>
      {stores.length === 0 ? (
        <>
          <p className={styles.note}>Suggest a store: leave your ZIP code and we&apos;ll tell you when a market opens near you.</p>
          <StoreRequestForm zip={null} />
        </>
      ) : null}
      {stores.length > 0 && shown.length === 0 && cuisine ? <NoneTagged cuisine={cuisine} onClear={onClear} /> : null}
      {shown.length > 0 ? <StoreGrid stores={shown} /> : null}
    </section>
  );
}

function Results({ answer, cuisine, refreshing, onClear }: { answer: StoresAnswer; cuisine: CuisineChip | null; refreshing: boolean; onClear: () => void }) {
  const place = answer.label ?? "you";
  const shown = withCuisine(answer.stores, cuisine?.value ?? null);
  const heading = answer.stores.length === 0
    ? "No stores are listed yet"
    : answer.nearby
      ? `Stores near ${place}`
      : `No stores within ${NEARBY_MILES} miles of ${place}`;
  return (
    <section aria-labelledby="near-results" className={styles.results} aria-busy={refreshing || undefined} data-refreshing={refreshing || undefined}>
      <div className={styles.resultsHead}>
        <h2 id="near-results" className={styles.resultsTitle}>{heading}</h2>
        {refreshing ? <span className={styles.refreshing}>Refreshing…</span> : null}
      </div>
      {!answer.nearby && answer.stores.length > 0 ? <p className={styles.note}>These are the closest stores.</p> : null}
      {answer.stores.length > 0 && shown.length === 0 && cuisine ? <NoneTagged cuisine={cuisine} onClear={onClear} /> : null}
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
