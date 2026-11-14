import { platformAdminApiDenial } from "@/lib/admin/session";
import { feeLedgerCsv, parseLedgerMonth } from "@/lib/admin/fee-ledger";
import { platformFeeLedger } from "@/lib/admin/fee-ledger-query";

/** CSV of one UTC month of the platform fee ledger, from the same rows the page shows (#546). Platform admin only. */
export async function GET(request: Request): Promise<Response> {
  const denied = await platformAdminApiDenial();
  if (denied) return denied;
  const month = parseLedgerMonth(new URL(request.url).searchParams.get("month") ?? undefined, new Date());
  const ledger = await platformFeeLedger(month);
  return new Response(feeLedgerCsv(ledger), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="platform-fee-ledger-${month}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
