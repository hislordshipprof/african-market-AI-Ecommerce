import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { ValidatedStore } from "@/lib/get-store";
import { editorial } from "@/lib/storefront/editorial";
import { ParallaxImage } from "./scroll-motion";
export function PromoBand({
  store,
  offer,
}: {
  store: ValidatedStore;
  offer?: string;
}) {
  return (
    <section className="sf-promo" data-testid="promo-band">
      <div className="sf-container">
        <div>
          <h2>{offer || "Your favorites.\nCloser than ever."}</h2>
          <p>
            {store.deliveryInfo ||
              `Local delivery within ${Number(store.deliveryRadiusMi)} miles.`}{" "}
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
