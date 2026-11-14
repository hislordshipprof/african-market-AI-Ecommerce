import Image from "next/image";
import type { StoreProfile } from "@/lib/storefront/service";
import { Store } from "lucide-react";
import { CountUp, SectionReveal } from "./scroll-motion";
const DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];
export function TrustStoryStrip({
  profile,
  demo = false,
  productCount,
}: {
  profile: StoreProfile;
  demo?: boolean;
  productCount?: number;
}) {
  if (!profile.ownerName && !profile.ownerStory) return null;
  const actualPhoto =
    profile.ownerPhotoUrl && !profile.ownerPhotoUrl.endsWith(".svg")
      ? profile.ownerPhotoUrl
      : null;
  const year = profile.ownerStory?.match(/since (\d{4})/)?.[1];
  const hours =
    profile.hours &&
    typeof profile.hours === "object" &&
    !Array.isArray(profile.hours)
      ? (profile.hours as Record<string, unknown>)
      : {};
  return (
    <section
      className="sf-story sf-container"
      data-testid="trust-strip"
      id="our-story"
    >
      <figure className="sf-story-photo">
        {actualPhoto ? (
          <Image
            src={actualPhoto}
            alt={profile.ownerName || "Store owner"}
            fill
            sizes="(max-width:767px) 100vw, 360px"
          />
        ) : (
          // No real store photo exists yet (PRODUCT.md), so the frame says so instead of using stock people.
          <div className="sf-story-placeholder" role="img" aria-label="Placeholder: the store's own photo will go here">
            <Store size={36} strokeWidth={1.5} aria-hidden />
            <strong>Store photo coming soon</strong>
            <span>Placeholder · the store adds its own photo</span>
          </div>
        )}
      </figure>
      <div className="sf-story-steps">
        <SectionReveal>
        <h2>
          A familiar face.
          <br />A taste of home.
        </h2>
        <p>
          {profile.ownerName}
          {profile.neighborhood && ` · ${profile.neighborhood}`}
        </p>
        {demo && <span className="sf-badge">Demo store story</span>}
        <p>{profile.ownerStory?.split(". ")[0]}.</p>
        </SectionReveal><SectionReveal className="sf-story-step">
          <h3>Good food. Familiar people.</h3>
          <p>{profile.ownerStory}</p>
          <p>
            Nothing is swapped without your approval. If an item is short, you
            choose a swap or a refund.
          </p>
        </SectionReveal>
        <div className="sf-story-facts">
          {year && (
            <div>
              <strong><CountUp value={new Date().getFullYear() - Number(year)} suffix=" years" /></strong>
              <span>Part of the neighborhood</span>
            </div>
          )}
          <div>
            <strong><CountUp value={profile.deliveryRadiusMi} suffix=" miles" /></strong>
            <span>Local delivery radius</span>
          </div>
          {productCount !== undefined && <div><strong><CountUp value={productCount} /></strong><span>Products on our shelves</span></div>}
        </div>
      </div>
      <div className="sf-hours">
        <h3>Come on in</h3>
        <dl>
          {DAYS.map((day) =>
            typeof hours[day] === "string" ? (
              <div key={day}>
                <dt>{day}</dt>
                <dd>{String(hours[day])}</dd>
              </div>
            ) : null,
          )}
        </dl>
        <p>
          {profile.pickupEnabled
            ? `Pickup ready in about ${profile.prepTimeMinutes} minutes.`
            : "Delivery available. Pickup is not offered."}
        </p>
        <p>No swaps without your approval.</p>
      </div>
    </section>
  );
}
