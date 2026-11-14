import { requireStoreOwner } from "@/lib/store-admin/session";
import { listCoupons } from "@/lib/coupon/service";
import { utcToStoreLocal } from "@/lib/coupon/form";
import { formatInZone } from "@/lib/format";
import { Promotions } from "./promotions";

export default async function PromotionsPage() {
  const session = await requireStoreOwner();
  const timeZone = session.store.timezone;
  const coupons = await listCoupons(session.store.id);
  const now = new Date();
  const when = (at: Date) => formatInZone(at, timeZone, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const zoneName = formatInZone(now, timeZone, { timeZoneName: "short" }).split(" ").pop() ?? timeZone;

  return (
    <Promotions
      storeName={session.store.name}
      storeSlug={session.store.slug}
      zoneName={zoneName}
      nowLocal={utcToStoreLocal(now, timeZone)}
      coupons={coupons.map((c) => ({
        id: c.id,
        code: c.code,
        kind: c.kind === "fixed" ? "fixed" : "percent",
        percentOff: c.percentOff,
        amountOffCents: c.amountOffCents,
        minGoodsCents: c.minGoodsCents,
        startsLocal: utcToStoreLocal(c.startsAt, timeZone),
        endsLocal: c.endsAt ? utcToStoreLocal(c.endsAt, timeZone) : "",
        startsLabel: when(c.startsAt),
        endsLabel: c.endsAt ? when(c.endsAt) : null,
        totalUses: c.totalUses,
        usesPerCustomer: c.usesPerCustomer,
        firstOrderOnly: c.firstOrderOnly,
        active: c.active,
        state: !c.active ? "inactive" : c.endsAt && c.endsAt <= now ? "ended" : c.startsAt > now ? "scheduled" : "live",
        usesSoFar: c.usesSoFar,
        discountGivenCents: c.discountGivenCents,
      }))}
    />
  );
}
