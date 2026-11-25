import Image from "next/image";
import type { CSSProperties } from "react";
import { directoryLink } from "@/lib/directory/attribution";
import { Check, ShoppingBag, Truck } from "lucide-react";
import type { DirectoryStore } from "@/lib/directory/stores";
import { storeInitials } from "@/lib/store-initials";
import { cuisineLabels } from "@/lib/directory/listing-fields";
import { formatMiles } from "@/lib/directory/distance";
import { deliveryFee, deliveryLine } from "@/lib/directory/delivery-line";
import { OpenNow } from "./open-now";
import styles from "./directory.module.css";

/** `distanceMi` and `deliversToYou` come only from a near me search (#452). */
export type CardStore = DirectoryStore & { href: string; distanceMi?: number; deliversToYou?: boolean };

// Store photos ship as .svg placeholders until the owner adds one, as on the storefront's story strip.
const ownerPhoto = (url: string | null) => (url && !url.endsWith(".svg") ? url : null);

/**
 * The directory's one card (#453, #863): the home, its search results and the state and city pages.
 * The store's own photo, or its colour when it has none; open now, then how to order. No delivery time:
 * none exists in data, and a courier's fee is only known from a quote (ADR-0006). The whole card is the link (#728).
 */
export function StoreCard({ store }: { store: CardStore }) {
  const delivery = deliveryLine(store);
  const fee = deliveryFee(store);
  const photo = ownerPhoto(store.ownerPhotoUrl);
  const cuisines = cuisineLabels(store.cuisineTags);
  const area = store.neighborhood?.trim() || [store.city, store.state].filter(Boolean).join(", ");
  const brand = { "--card-brand": store.brandColor ?? undefined } as CSSProperties;
  return (
    <a className={styles.card} href={directoryLink(store.href)}>
      <span className={styles.cardMedia} style={brand} data-photo={photo ? true : undefined}>
        {photo ? <Image className={styles.cardPhoto} src={photo} alt="" fill sizes="(min-width: 1024px) 25vw, (min-width: 640px) 50vw, 100vw" unoptimized /> : null}
        <span className={styles.cardOpen}>
          <OpenNow hours={store.hours} timezone={store.timezone} />
        </span>
        <span className={styles.cardPlate}>
          {store.logoUrl ? (
            <Image className={styles.logo} src={store.logoUrl} alt="" width={44} height={44} unoptimized />
          ) : (
            <span className={styles.initials} aria-hidden="true">{storeInitials(store.name)}</span>
          )}
        </span>
      </span>
      <span className={styles.cardBody}>
        <span className={styles.cardTitle}>
          <span className={styles.name}>{store.name}</span>
          {store.distanceMi !== undefined ? (
            <span className={styles.distance}>
              {formatMiles(store.distanceMi)}
              <span className={styles.srOnly}> away</span>
            </span>
          ) : null}
        </span>
        <span className={styles.place}>{[area, ...cuisines].filter(Boolean).join(", ")}</span>
        {store.listingBlurb ? <span className={styles.blurb}>{store.listingBlurb}</span> : null}
        {store.pickupEnabled || delivery ? (
          <span className={styles.flags}>
            {delivery && delivery !== "Courier may be available" ? (
              <span className={styles.flag}>
                {delivery === "Delivers to you" ? <Check aria-hidden="true" size={16} /> : <Truck aria-hidden="true" size={16} />}
                {delivery}
                {fee ? <span className={styles.fee}>{fee}</span> : null}
              </span>
            ) : null}
            {store.pickupEnabled ? (
              <span className={styles.flag}><ShoppingBag aria-hidden="true" size={16} />Pickup</span>
            ) : null}
            {delivery === "Courier may be available" ? (
              <span className={styles.flag} data-maybe><Truck aria-hidden="true" size={16} />{delivery}</span>
            ) : null}
          </span>
        ) : null}
      </span>
    </a>
  );
}
