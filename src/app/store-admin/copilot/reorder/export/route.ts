import { requireStoreOwner } from "@/lib/store-admin/session";
import { storeMayUse } from "@/lib/billing/plan";
import { loadReorderList, reorderCsv } from "@/lib/copilot/reorder-list";

/** The saved reorder list as CSV (#551). Owner and Pro only. */
export async function GET() {
  const { store } = await requireStoreOwner();
  if (!(await storeMayUse(store.id, "reorder-suggestions"))) {
    return new Response("Reorder suggestions are a Pro feature.", { status: 403 });
  }
  const list = await loadReorderList(store.id);
  if (!list) return new Response("No reorder list saved yet.", { status: 404 });
  return new Response(reorderCsv(list), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${store.slug}-reorder-${list.savedAt.toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
