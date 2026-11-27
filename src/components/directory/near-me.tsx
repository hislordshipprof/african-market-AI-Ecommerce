"use client";

import { useReducer, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { Check, LocateFixed, MapPin, MapPinOff, RotateCw, ShoppingBag, Truck } from "lucide-react";
import { NEARBY_MILES } from "@/lib/directory/distance";
import { splitByDelivery } from "@/lib/directory/delivery-line";
import { withCuisine, type CuisineChip } from "@/lib/directory/cuisine-filter";
import { fetchNear, nearSearch, type NearAnswer, type NearState } from "@/lib/directory/near-search";
import { StoreCard, type CardStore } from "./store-card";
import { StoreRequestForm } from "./store-request-form";
import styles from "./directory.module.css";

type PlaceLink = { name: string; href: string; count: number };
export type StateGroup = { code: string; name: string; href: string; count: number; cities: PlaceLink[] };

type Answer = NearAnswer<CardStore>;
type StoresAnswer = Extract<Answer, { kind: "stores" }>;

const IDLE: NearState<CardStore> = { answer: null, pending: false, failure: null };
const DENIED = "Location is off for this site. Enter your ZIP code or city instead.";
const UNAVAILABLE = "We couldn't get your location. Enter your ZIP code or city instead.";

/**
 * Store directory near me (#452, #863). Location is asked for only when the shopper taps the button.
 * The hero frames the search; results split into the store's own delivery to the shopper and pickup,
 * and a cuisine chip filters them. A new or failed search keeps the last results on screen (#728).
 */
export function NearMe({ stores, chips, intro, owner, figure, turnstileSiteKey }: {
  stores: CardStore[];
  turnstileSiteKey: string | null;
  chips: CuisineChip[];
  intro: ReactNode;
  owner: ReactNode;
  figure: ReactNode;
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
        <div className={styles.heroInner}>
          <div className={styles.heroText}>
            {intro}
            <form className={styles.search} onSubmit={onSubmit} role="search" aria-label="Find stores near you">
              <label className={styles.srOnly} htmlFor="near-query">ZIP code or city</label>
              <div className={styles.searchRow}>
                <span className={styles.searchField}>
                  <MapPin aria-hidden="true" size={20} />
                  <input
                    ref={input}
                    id="near-query"
                    className={styles.searchInput}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Enter ZIP code or city"
                    maxLength={80}
                    autoComplete="postal-code"
                    required
                  />
                </span>
                <button type="submit" className={styles.searchButton} disabled={pending}>Find stores</button>
              </div>
            </form>
            <button type="button" className={styles.locate} onClick={locateMe} disabled={pending}>
              <LocateFixed aria-hidden="true" size={16} />
              Use my location
            </button>

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
            {owner}
          </div>
          {figure}
        </div>
      </section>

      <div className={styles.section}>
        {answer?.kind === "stores" && answer.nearby && answer.stores.length > 0 ? (
          <Results answer={answer} chips={chips} cuisine={chosen} refreshing={pending} onChoose={toggleCuisine} onClear={clearCuisine} />
        ) : null}
        {answer?.kind === "stores" && !(answer.nearby && answer.stores.length > 0) ? <EmptyArea answer={answer} refreshing={pending} turnstileSiteKey={turnstileSiteKey} /> : null}
        {answer?.kind === "stores" || answer?.kind === "outside" ? null : <AllStores stores={stores} turnstileSiteKey={turnstileSiteKey} />}
      </div>
    </>
  );
}

/** Cuisine stays a filter on results only (#863): one tap filters, a second tap on the same chip clears it. */
function Chips({ chips, chosen, onChoose }: { chips: CuisineChip[]; chosen: CuisineChip | null; onChoose: (value: string) => void }) {
  if (chips.length === 0) return null;
  return (
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

function AllStores({ stores, turnstileSiteKey }: { stores: CardStore[]; turnstileSiteKey: string | null }) {
  return (
    <section aria-labelledby="directory-stores" className={styles.results}>
      <div className={styles.resultsHead}>
        <h2 id="directory-stores" className={styles.sectionTitle}>{stores.length === 0 ? "No stores are listed yet" : "Markets to order from"}</h2>
        {stores.length > 0 ? <p className={styles.count}>{stores.length === 1 ? "1 market" : `${stores.length} markets`}</p> : null}
      </div>
      {stores.length === 0 ? (
        <>
          <p className={styles.note}>Suggest a store: leave your ZIP code and we&apos;ll tell you when a market opens near you.</p>
          <StoreRequestForm zip={null} turnstileSiteKey={turnstileSiteKey} />
        </>
      ) : (
        <StoreGrid stores={stores} />
      )}
    </section>
  );
}

function Results({ answer, chips, cuisine, refreshing, onChoose, onClear }: {
  answer: StoresAnswer;
  chips: CuisineChip[];
  cuisine: CuisineChip | null;
  refreshing: boolean;
  onChoose: (value: string) => void;
  onClear: () => void;
}) {
  const place = answer.label ?? "you";
  const shown = withCuisine(answer.stores, cuisine?.value ?? null);
  const { door, pickup, other } = splitByDelivery(shown);
  const where = answer.label ?? "your location";
  return (
    <section aria-labelledby="near-results" className={styles.results} aria-busy={refreshing || undefined} data-refreshing={refreshing || undefined}>
      <div className={styles.resultsHead}>
        <h2 id="near-results" className={styles.sectionTitle}>Stores near {place}</h2>
        {refreshing ? <span className={styles.refreshing}>Refreshing…</span> : null}
      </div>
      <Chips chips={chips} chosen={cuisine} onChoose={onChoose} />
      {shown.length === 0 && cuisine ? <NoneTagged cuisine={cuisine} onClear={onClear} /> : null}
      {door.length > 0 ? (
        <section aria-labelledby="near-door" className={styles.group}>
          <h3 id="near-door" className={styles.groupTitle}><Truck aria-hidden="true" size={20} />Delivers to your door</h3>
          <StoreGrid stores={door} />
        </section>
      ) : null}
      {pickup.length > 0 ? (
        <section aria-labelledby="near-pickup" className={styles.group}>
          <h3 id="near-pickup" className={styles.groupTitle}><ShoppingBag aria-hidden="true" size={20} />Pickup nearby</h3>
          <p className={styles.note}>These markets do not deliver to {where} with their own driver. Order ahead and collect.</p>
          <StoreGrid stores={pickup} />
        </section>
      ) : null}
      {other.length > 0 ? (
        <section aria-labelledby="near-other" className={styles.group}>
          <h3 id="near-other" className={styles.groupTitle}>Other markets nearby</h3>
          <StoreGrid stores={other} />
        </section>
      ) : null}
    </section>
  );
}

/** No store within 50 miles (#455, #863): ask to hear when one opens, and see the closest stores anyway. */
function EmptyArea({ answer, refreshing, turnstileSiteKey }: { answer: StoresAnswer; refreshing: boolean; turnstileSiteKey: string | null }) {
  const place = answer.label ?? "your area";
  const zip = answer.label && /^\d{5}$/.test(answer.label) ? answer.label : null;
  return (
    <section aria-labelledby="near-results" className={styles.results} aria-busy={refreshing || undefined} data-refreshing={refreshing || undefined}>
      <div className={styles.emptyHead}>
        <span className={styles.emptyIcon} aria-hidden="true"><MapPinOff size={24} /></span>
        <h2 id="near-results" className={styles.emptyTitle}>
          No stores serve {place} yet
        </h2>
        <p className={styles.lede}>
          Nothing is listed within {NEARBY_MILES} miles of {place}. Ask for one and we&apos;ll message you once, when a market opens near you.
        </p>
      </div>
      <div className={styles.emptyGrid}>
        <StoreRequestForm zip={zip} turnstileSiteKey={turnstileSiteKey} />
        <aside aria-labelledby="empty-owner" className={styles.ownerBand}>
          <h3 id="empty-owner" className={styles.ownerBandTitle}>Know a market owner near {place}?</h3>
          <p>Send them the sell page. They keep their own brand, prices and customers.</p>
          <Link href="/sell" className={styles.lightButton}>Sell on African Markets</Link>
        </aside>
      </div>
      {answer.stores.length > 0 ? (
        <section aria-labelledby="near-closest" className={styles.group}>
          <h3 id="near-closest" className={styles.groupTitle}>The closest stores</h3>
          <StoreGrid stores={answer.stores} />
        </section>
      ) : null}
    </section>
  );
}
