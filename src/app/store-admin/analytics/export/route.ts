import { requireStoreOwner } from "@/lib/store-admin/session";
import { planAllows, storePlan } from "@/lib/billing/plan";
import { resolveRange } from "@/lib/analytics/range";
import { storeAnalytics } from "@/lib/analytics/queries";
import { ANALYTICS_VIEWS, analyticsCsv, type AnalyticsView } from "@/lib/analytics/csv";

/** CSV of one analytics view, from the same numbers the page shows (#498). Pro only. */
export async function GET(request: Request) {
  const { store } = await requireStoreOwner();
  if (!planAllows(await storePlan(store.id), "analytics-dashboard")) {
    return new Response("Analytics is a Pro feature.", { status: 403 });
  }
  const params = new URL(request.url).searchParams;
  const view = params.get("view") as AnalyticsView;
  if (!ANALYTICS_VIEWS.includes(view)) return new Response("Unknown view.", { status: 400 });
  const range = resolveRange(
    { range: params.get("range") ?? undefined, from: params.get("from") ?? undefined, to: params.get("to") ?? undefined },
    store.timezone,
  );
  const body = analyticsCsv(view, await storeAnalytics(store.id, store.timezone, range));
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${store.slug}-${view}-${range.from}-to-${range.to}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
