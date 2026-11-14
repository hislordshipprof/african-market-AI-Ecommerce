import { requireStoreOwner } from "@/lib/store-admin/session";
import { payoutCsv } from "@/lib/payouts/breakdown";
import { storePayoutDetail } from "@/lib/payouts/service";

/** CSV of one payout's orders, from the same numbers the page shows (#548). Owner only. */
export async function GET(_request: Request, { params }: { params: Promise<{ payoutId: string }> }) {
  const { store } = await requireStoreOwner();
  const { payoutId } = await params;
  const detail = await storePayoutDetail(store, payoutId);
  if (!detail.ok) return new Response(detail.notFound ? "Payout not found." : detail.error, { status: detail.notFound ? 404 : 502 });
  const day = new Date(detail.payout.arrivalDate * 1000).toISOString().slice(0, 10);
  return new Response(payoutCsv(detail.breakdown), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${store.slug}-payout-${day}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
