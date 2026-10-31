import Image from "next/image";
import { User, MapPin, Truck, ShieldCheck, RefreshCw } from "lucide-react";
import type { StoreProfile } from "@/lib/storefront/service";

export function TrustStoryStrip({ profile }: { profile: StoreProfile }) {
  if (!profile.ownerName && !profile.ownerStory) return null;

  const excerpt =
    profile.ownerStory && profile.ownerStory.length > 120
      ? profile.ownerStory.slice(0, 120).trimEnd() + "…"
      : profile.ownerStory;

  return (
    <section
      data-testid="trust-strip"
      className="border-t border-line bg-surface px-4 py-6 sm:px-6"
    >
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 sm:flex-row sm:gap-6">
        <div className="shrink-0">
          {profile.ownerPhotoUrl ? (
            <Image
              src={profile.ownerPhotoUrl}
              alt={profile.ownerName || "Store owner"}
              width={64}
              height={64}
              className="h-16 w-16 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-soft">
              <User className="h-7 w-7 text-muted-foreground" aria-hidden="true" />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1 text-center sm:text-left">
          {profile.ownerName && (
            <p className="font-display text-base font-bold text-ink">
              {profile.ownerName}
            </p>
          )}
          {excerpt && (
            <p className="mt-0.5 font-body text-sm leading-relaxed text-muted-foreground">
              {excerpt}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-col gap-2 text-center sm:text-right">
          {profile.neighborhood && (
            <span className="inline-flex items-center justify-center gap-1.5 font-label text-[13px] text-muted-foreground sm:justify-end">
              <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
              {profile.neighborhood}
            </span>
          )}
          {profile.deliveryInfo && (
            <span className="inline-flex items-center justify-center gap-1.5 font-label text-[13px] text-muted-foreground sm:justify-end">
              <Truck className="h-3.5 w-3.5" aria-hidden="true" />
              {profile.deliveryInfo}
            </span>
          )}
          {profile.pickupEnabled && (
            <span className="inline-flex items-center justify-center gap-1.5 font-label text-[13px] text-muted-foreground sm:justify-end">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              Pickup available
            </span>
          )}
          <span className="inline-flex items-center justify-center gap-1.5 font-label text-[13px] text-muted-foreground sm:justify-end">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Wrong item? We swap it free
          </span>
        </div>
      </div>
    </section>
  );
}
