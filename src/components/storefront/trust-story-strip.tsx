import Image from "next/image";
import type { StoreProfile } from "@/lib/storefront/service";
import { editorial } from "@/lib/storefront/editorial";
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
}: {
  profile: StoreProfile;
  demo?: boolean;
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
        <Image
          src={actualPhoto || editorial.market}
          alt={
            actualPhoto
              ? profile.ownerName || "Store owner"
              : "Bodija Market in Ibadan, Nigeria"
          }
          fill
          sizes="(max-width:767px) 100vw, 360px"
        />
        {!actualPhoto && (
          <figcaption>
            Market inspiration · Bodija, Ibadan · Tunde Buremo
          </figcaption>
        )}
      </figure>
      <div>
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
        <details>
          <summary>Read more about our store</summary>
          <p>{profile.ownerStory}</p>
          <p>
            Nothing is swapped without your approval. If an item is short, you
            choose a swap or a refund.
          </p>
        </details>
        <div className="sf-story-facts">
          {year && (
            <div>
              <strong>{new Date().getFullYear() - Number(year)} years</strong>
              <span>Part of the neighborhood</span>
            </div>
          )}
          <div>
            <strong>{profile.deliveryRadiusMi} miles</strong>
            <span>Local delivery radius</span>
          </div>
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
