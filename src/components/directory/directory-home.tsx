import Image from "next/image";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftRight, BellRing, Camera, Landmark, MapPin, Palette, Plus, Smartphone, Sparkles, Store, Truck, UserRound,
} from "lucide-react";
import { PlanComparison } from "@/components/billing/plan-comparison";
import { cuisineChips } from "@/lib/directory/cuisine-filter";
import { SELL_STEPS } from "@/lib/store-application/steps";
import ordersScreen from "../../../public/images/directory/store-admin-orders.webp";
import egusi from "../../../public/images/products/egusi-seeds-whole.webp";
import garri from "../../../public/images/products/garri-yellow.webp";
import palmOil from "../../../public/images/products/palm-oil-red.webp";
import { DirectoryFooter, STATES_ANCHOR } from "./directory-footer";
import { NearMe, type StateGroup } from "./near-me";
import type { CardStore } from "./store-card";
import styles from "./directory.module.css";

/**
 * The Store directory home, design B2 (#863): the shopper's search first, then what the platform gives
 * shoppers and store owners. Plans, the pilot offer and the fee note come from code, never this page.
 */
export function DirectoryHome({ stores, states, offer, feeNote }: { stores: CardStore[]; states: StateGroup[]; offer?: string; feeNote: string }) {
  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <span className={styles.wordmark}>African Markets</span>
        <Link className={styles.sell} href="/sell">Sell on African Markets</Link>
      </header>
      <main>
        <NearMe
          stores={stores}
          chips={cuisineChips(stores)}
          intro={(
            <>
              <h1 id="directory-title" className={styles.heroTitle}>Order from the African market near you</h1>
              <p className={styles.heroLede}>
                African Markets puts independent African and Caribbean grocery markets online. Each one has its own shop, with its own shelves and prices, for pickup or delivery.
              </p>
            </>
          )}
          owner={(
            <div className={styles.heroOwner}>
              <p><strong>Own a market?</strong> Get your own online store, with no commission on your sales.</p>
              <Link href="/sell" className={styles.outlineLight}>
                <Store aria-hidden="true" size={16} />
                Open your store
              </Link>
            </div>
          )}
          figure={<HeroFigure />}
        />
        <ForShoppers feeNote={feeNote} />
        <ForOwners offer={offer} />
        {states.length > 0 ? <ByState states={states} /> : null}
        <section aria-labelledby="close-title" className={styles.section}>
          <div className={styles.closing}>
            <div>
              <h2 id="close-title" className={styles.closingTitle}>Run an African or Caribbean market? Bring it online.</h2>
              <p className={styles.note}>Apply in about three minutes. Our team reviews every store and replies by email.</p>
            </div>
            <div className={styles.actions}>
              <Link href="/sell" className={styles.primaryButton}>Apply to sell</Link>
              <a href="#plans" className={styles.outlineButton}>See plans</a>
            </div>
          </div>
        </section>
      </main>
      <DirectoryFooter />
    </div>
  );
}

// The demo store's own products and prices (prisma/seed-demo-catalog.ts), drawn as its shop; the caption says so.
const DEMO_SHELF = [
  { name: "Yellow Garri (Ijebu), 1 lb", price: "$6.99", image: garri },
  { name: "Egusi, 8 oz", price: "$10.99", image: egusi },
  { name: "Palm Oil, 500 ml", price: "$7.99", image: palmOil },
];

/** One order, both sides: a market's own shop, and the real store-admin Orders screen on a phone. */
function HeroFigure() {
  return (
    <figure className={styles.heroFigure}>
      <div className={styles.shop} aria-hidden="true">
        <div className={styles.shopHead}>
          <span className={styles.shopLogo}>MN</span>
          <span className={styles.shopName}>
            <span>Mama Ngozi</span>
            <span className={styles.shopOpen}><span className={styles.openDot} />Open now</span>
          </span>
          <span className={styles.shopToggle}><span data-on>Pickup</span><span>Delivery</span></span>
        </div>
        <div className={styles.shopAisles}>
          <span data-on>Grains and flours</span><span>Spices</span><span>Oils</span><span>Vegetables</span>
        </div>
        <ul className={styles.shopShelf}>
          {DEMO_SHELF.map((item) => (
            <li key={item.name}>
              <span className={styles.shopWell}>
                <Image src={item.image} alt="" sizes="120px" className={styles.shopImage} />
              </span>
              <span className={styles.shopItem}>{item.name}</span>
              <span className={styles.shopPrice}>
                {item.price}
                <span className={styles.shopAdd}><Plus size={16} /></span>
              </span>
            </li>
          ))}
        </ul>
        <div className={styles.shopAsk}><Sparkles size={16} />Shop with AI: &quot;everything for egusi soup for six&quot;</div>
      </div>
      <div className={styles.heroPhone}>
        <Image
          src={ordersScreen}
          alt="The store admin Orders screen on a phone, with demo orders marked New, Accepted, Picking and Awaiting pickup."
          sizes="170px"
        />
      </div>
      <figcaption className={styles.heroCaption}>
        <span><strong>Shoppers</strong> order from the market&apos;s own shop. Demo store.</span>
        <span className={styles.heroCaptionOwner}><strong>Owners</strong> run orders from a phone.</span>
      </figcaption>
    </figure>
  );
}

type Benefit = { icon: LucideIcon; title: string; body: string };

// Each claim is true in the product today (#863): checked against the storefront, checkout and store admin.
const SHOPPER_BENEFITS: Benefit[] = [
  { icon: MapPin, title: "Markets that serve your address", body: "Enter a ZIP code. See who delivers to you, and who is close enough for pickup." },
  { icon: Store, title: "The market's own shelves and prices", body: "Search by the names you use at home: ugu, ata rodo, iru." },
  { icon: Truck, title: "Pickup or delivery", body: "Pick a pickup time, or get it delivered by the market's driver or a courier, where the market offers it." },
  { icon: ArrowLeftRight, title: "You set the swap rule", body: "For each item: exact item only, let the store suggest, or name your own swap. If an item runs short, you get a message to swap or refund." },
  { icon: Sparkles, title: "Shop with AI, if you like", body: "Say what you are cooking or send a photo of your list. It fills the cart; you check it and pay." },
  { icon: UserRound, title: "One account for every market", body: "Sign in once and use it at any market here, or check out as a guest." },
];

const SHOPPING_STEPS = [
  { title: "Find your market", body: "Search by ZIP code or city, or browse by state." },
  { title: "Shop on its own site", body: "Each market has its own shop, shelves and prices. Your cart stays with that market." },
  { title: "Pay that market directly", body: "The market is the seller, so its name is on your card statement. It packs your order for pickup or delivery." },
];

function ForShoppers({ feeNote }: { feeNote: string }) {
  return (
    <section id="shoppers" aria-labelledby="shoppers-title" className={styles.section}>
      <div className={styles.split}>
        <div>
          <h2 id="shoppers-title" className={styles.bigTitle}>For shoppers: the market you know, now online</h2>
          <p className={styles.note}>You shop one market at a time, on that market&apos;s own site. The market&apos;s own staff pack your order, and your cart stays with the market you chose.</p>
        </div>
        <ul className={styles.benefits}>
          {SHOPPER_BENEFITS.map(({ icon: Icon, title, body }) => (
            <li key={title}>
              <span className={styles.benefitIcon}><Icon aria-hidden="true" size={20} /></span>
              <span>
                <span className={styles.benefitTitle}>{title}</span>
                <span className={styles.benefitBody}>{body}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className={styles.howPanel}>
        <h3 className={styles.panelTitle}>How shopping works</h3>
        <Steps steps={SHOPPING_STEPS} columns />
        <p className={styles.feeNote}>{feeNote}</p>
      </div>
    </section>
  );
}

const OWNER_BENEFITS: Benefit[] = [
  { icon: Palette, title: "Your brand, your shop", body: "Your shop carries your name, logo and colours, with your own hours and pickup times." },
  { icon: Smartphone, title: "Orders on your phone", body: "Accept, pick from a list, mark what is short, and tap Ready." },
  { icon: Camera, title: "Products from shelf photos", body: "Photograph a shelf; we draft the listings and you check the prices. CSV import too." },
  { icon: Truck, title: "Pickup and delivery", body: "Pickup and your own driver on every plan. Uber or DoorDash couriers on Pro." },
  { icon: BellRing, title: "A copilot for your stock", body: "Stock alerts and a daily digest on every plan. Chat with the store assistant on Pro." },
  { icon: Landmark, title: "Paid through Stripe", body: "Customers pay by card at checkout, and Stripe pays your sales into your bank." },
];

function ForOwners({ offer }: { offer?: string }) {
  return (
    <section id="sell" aria-labelledby="owners-title" className={styles.section}>
      <div className={styles.owners}>
        <div className={styles.ownersText}>
          <h2 id="owners-title" className={styles.bigTitle}>For store owners: your market, with its own online store</h2>
          <p>Your shop goes out under your name, to your customers. You pay a flat monthly plan, and no commission on your sales.</p>
          <ul className={styles.ownerBenefits}>
            {OWNER_BENEFITS.map(({ icon: Icon, title, body }) => (
              <li key={title}>
                <Icon aria-hidden="true" size={20} />
                <span>
                  <span className={styles.benefitTitle}>{title}</span>
                  <span className={styles.benefitBody}>{body}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className={styles.actions}>
            <Link href="/sell" className={styles.accentButton}>Apply to sell</Link>
            <a href="#plans" className={styles.outlineLight}>Compare plans</a>
          </div>
        </div>
        <figure className={styles.ownersScreen}>
          <figcaption>The real Orders screen, demo store.</figcaption>
          <div className={styles.ownersPhone}>
            <Image
              src={ordersScreen}
              alt="The Orders screen in the store admin, on a phone, with demo orders."
              sizes="(min-width: 768px) 290px, 240px"
            />
          </div>
        </figure>
      </div>
      <div className={styles.sellGrid}>
        <div>
          <h3 className={styles.panelTitle}>How opening a store works</h3>
          <Steps steps={SELL_STEPS} />
          <p className={styles.note}>Any independent US grocery or food store can apply. Restaurants cannot join yet.</p>
        </div>
        <div className={styles.planTheme}>
          <PlanComparison offer={offer} recommend />
        </div>
      </div>
    </section>
  );
}

function Steps({ steps, columns }: { steps: readonly { title: string; body: string }[]; columns?: boolean }) {
  return (
    <ol className={styles.steps} data-columns={columns || undefined}>
      {steps.map(({ title, body }, index) => (
        <li key={title}>
          <span className={styles.stepNumber} aria-hidden="true">{index + 1}</span>
          <span>
            <span className={styles.benefitTitle}>{title}</span>
            <span className={styles.benefitBody}>{body}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Every state with a listed store and its cities, one tap from home (#810); footers link here. */
function ByState({ states }: { states: StateGroup[] }) {
  return (
    <section aria-labelledby={STATES_ANCHOR} className={styles.section}>
      <h2 id={STATES_ANCHOR} className={styles.sectionTitle}>Markets by state and city</h2>
      <ul className={styles.stateCards}>
        {states.map((state) => (
          <li key={state.code} className={styles.stateCard}>
            <Link href={state.href} className={styles.stateLink}>
              {state.name}
              <span className={styles.placeCount}>{state.count === 1 ? "1 market" : `${state.count} markets`}</span>
            </Link>
            {state.cities.length > 0 ? (
              <ul className={styles.cityLinks}>
                {state.cities.map((city) => (
                  <li key={city.href}>
                    <Link href={city.href}>
                      <span>{city.name}</span>
                      <span className={styles.placeCount}>{city.count}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
