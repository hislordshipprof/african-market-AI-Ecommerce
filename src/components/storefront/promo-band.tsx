import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { ValidatedStore } from "@/lib/get-store";
import { storeDeliveryOffered } from "@/lib/delivery/store-delivery-offered";
import { editorial } from "@/lib/storefront/editorial";
import { ParallaxImage } from "./scroll-motion";
export function PromoBand({
  store,
  offer,
}: {
  store: ValidatedStore;
  offer?: string;
}) {
  // The band promises only what checkout offers (#775): a pickup-only store says pickup (#783).
  const delivers = storeDeliveryOffered(store);
  const fulfilment = delivers
    ? store.deliveryInfo || `Local delivery within ${Number(store.deliveryRadiusMi)} miles.`
    : store.pickupEnabled
      ? "Order ahead and pick up in store."
      : "";
  return (
    <section className="sf-promo" data-testid="promo-band">
      <div className="sf-container">
        <div>
          <h2>{(delivers && offer) || "Your favorites.\nCloser than ever."}</h2>
          <p>
            {fulfilment && `${fulfilment} `}
            Real store prices, from the people who know your pantry.
          </p>
          <Link href="/categories" className="sf-button">
            Fill your basket <ArrowRight size={18} />
          </Link>
        </div>
        <div className="sf-promo-photo">
          <ParallaxImage><Image
            src={editorial.spices}
            alt="Spices and herbs for the pantry"
            fill
            sizes="(max-width:767px) 40vw, 520px"
          /></ParallaxImage>
        </div>
      </div>
    </section>
  );
}
