import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { BODIJA_MARKET, POSTER_MID_MEDIA, POSTER_WIDE_MEDIA } from "@/components/story-surface/scenes";
import { cuisineChips } from "@/lib/directory/cuisine-filter";
import { directoryCounts, ownerQuotes, type OwnerQuote } from "@/lib/directory/home-story";
import ordersScreen from "../../../public/images/directory/store-admin-orders.webp";
import { DirectoryFooter, STATES_ANCHOR } from "./directory-footer";
import { NearMe, type StateGroup } from "./near-me";
import type { CardStore } from "./store-card";
import styles from "./directory.module.css";

export function DirectoryHome({ stores, states }: { stores: CardStore[]; states: StateGroup[] }) {
  const quotes = ownerQuotes(stores);
  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <span className={styles.wordmark}>African Markets</span>
        <Link className={styles.sell} href="/sell">Sell on African Markets</Link>
      </header>
      <main>
        <NearMe
          states={states}
          stores={stores}
          chips={cuisineChips(stores)}
          backdrop={<HeroPhoto />}
          intro={(
            <>
              <h1 id="directory-title" className={styles.heroTitle}>Your food, from the families who know it</h1>
              <p className={styles.heroLede}>
                Independent markets across the US, run by people who stock what you grew up cooking. Find one near you, then order pickup or delivery from that market&apos;s own shop.
              </p>
            </>
          )}
          counts={<Counts {...directoryCounts(stores)} />}
        />
        {states.length > 0 ? <StoresByState states={states} /> : null}
        <HowItWorks />
        {quotes.length > 0 ? <OwnerStories quotes={quotes} /> : null}
        <ForOwners />
      </main>
      <DirectoryFooter />
    </div>
  );
}

// A real market in Ibadan, credited in public/images/CREDITS.md; the caption says so, so nobody takes it for a store here.
function HeroPhoto() {
  const scene = BODIJA_MARKET;
  return (
    <>
      <picture className={styles.heroPhoto}>
        <source media={POSTER_WIDE_MEDIA} srcSet={scene.posterWide.src} />
        <source media={POSTER_MID_MEDIA} srcSet={scene.posterMid.src} />
        <img src={scene.posterTall.src} width={scene.posterTall.width} height={scene.posterTall.height} alt="" fetchPriority="high" />
      </picture>
      <p className={styles.heroCredit}>Photo: a stall at {scene.place}, Nigeria, by {scene.photographer}</p>
    </>
  );
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** True counts of listed stores; a zero is left out, and all zeros show nothing. */
function Counts({ markets, cities, states }: { markets: number; cities: number; states: number }) {
  const parts = [
    markets > 0 ? plural(markets, "market", "markets") : null,
    cities > 0 ? plural(cities, "city", "cities") : null,
    states > 0 ? plural(states, "state", "states") : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  return (
    <ul className={styles.counts} aria-label="Listed today">
      {parts.map((part) => <li key={part}>{part}</li>)}
    </ul>
  );
}

/** Every state with a listed store, so its page is one tap from home (#810); each state page links its cities. */
function StoresByState({ states }: { states: StateGroup[] }) {
  return (
    <section aria-labelledby={STATES_ANCHOR} className={`${styles.section} ${styles.byState}`}>
      <h2 id={STATES_ANCHOR} className={styles.sectionTitle}>Stores by state</h2>
      <ul className={styles.placeLinks}>
        {states.map((state) => (
          <li key={state.code}>
            <Link href={state.href} className={styles.placeLink}>
              {state.name}
              <span className={styles.placeCount}>{state.stores.length}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

const STEPS = [
  { title: "Find your market", body: "Search by ZIP code or city, or browse by where home is." },
  { title: "Shop on its own site", body: "Each market has its own shop, shelves and prices. Your cart stays with that market." },
  { title: "Pay that market directly", body: "The market is the seller, so its name is on your card statement. It packs your order for pickup or delivery." },
];

function HowItWorks() {
  return (
    <section aria-labelledby="how-title" className={styles.band}>
      <div className={styles.section}>
        <h2 id="how-title" className={styles.sectionTitle}>How it works</h2>
        <ol className={styles.steps}>
          {STEPS.map(({ title, body }, index) => (
            <li key={title}>
              <span className={styles.stepNumber} aria-hidden="true">{index + 1}</span>
              <h3 className={styles.stepTitle}>{title}</h3>
              <p className={styles.stepBody}>{body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// Store photos ship as .svg placeholders until the owner adds one, as on the storefront's story strip.
const ownerPhoto = (url: string | null) => (url && !url.endsWith(".svg") ? url : null);

function OwnerStories({ quotes }: { quotes: OwnerQuote[] }) {
  return (
    <section aria-labelledby="stories-title" className={styles.section}>
      <h2 id="stories-title" className={styles.sectionTitle}>In the owners&apos; words</h2>
      <ul className={styles.quotes} data-count={quotes.length}>
        {quotes.map((quote) => {
          const photo = ownerPhoto(quote.ownerPhotoUrl);
          return (
            <li key={quote.slug}>
              <figure className={styles.quote}>
                <blockquote className={styles.quoteText}><p>{quote.quote}</p></blockquote>
                <figcaption className={styles.quoteBy}>
                  {photo ? <Image className={styles.quoteFace} src={photo} alt="" width={40} height={40} unoptimized /> : null}
                  <span>
                    {quote.ownerName ? <span className={styles.quoteName}>{quote.ownerName}</span> : null}
                    <span className={styles.quoteStore}>{quote.name}</span>
                  </span>
                </figcaption>
              </figure>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const PITCH = [
  { title: "Your own branded site", body: "Your name, logo and colors on your own shop, not a listing in someone else's." },
  { title: "Your own customers", body: "Shoppers order from your shop, and the relationship stays yours." },
  { title: "No commission on your sales", body: "Set your own prices and keep your sales." },
];

function ForOwners() {
  return (
    <section aria-labelledby="owners-title" className={styles.owners}>
      <div className={`${styles.section} ${styles.ownersInner}`}>
        <div className={styles.ownersText}>
          <h2 id="owners-title" className={styles.ownersTitle}>Run a market? Put it online under your own name.</h2>
          <ul className={styles.pitch}>
            {PITCH.map((point) => (
              <li key={point.title}>
                <span className={styles.pitchTitle}>{point.title}</span>
                <span className={styles.pitchBody}>{point.body}</span>
              </li>
            ))}
          </ul>
          <Link className={styles.ownersButton} href="/sell">
            Sell on African Markets
            <ArrowRight aria-hidden="true" size={18} />
          </Link>
        </div>
        <figure className={styles.screen}>
          <Image
            className={styles.screenImage}
            src={ordersScreen}
            alt="The Orders screen of a store admin on a phone: five orders, each with its number, status, customer, item count and total."
            sizes="(min-width: 900px) 300px, 70vw"
          />
          <figcaption className={styles.screenCaption}>The order screen in the store admin, shown with the demo store&apos;s test orders.</figcaption>
        </figure>
      </div>
    </section>
  );
}
