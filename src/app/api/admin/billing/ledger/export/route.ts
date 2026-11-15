import { z } from "zod";
import { platformAdminApiDenial } from "@/lib/admin/session";
import { LEDGER_MONTH, feeLedgerCsv, parseLedgerMonth } from "@/lib/admin/fee-ledger";
import { platformFeeLedger } from "@/lib/admin/fee-ledger-query";
import { parseInput } from "@/lib/security/parse-input";

const query = z.object({ month: z.string().regex(LEDGER_MONTH).optional() });

/** CSV of one UTC month of the platform fee ledger, from the same rows the page shows (#546). Platform admin only. */
export async function GET(request: Request): Promise<Response> {
  const denied = await platformAdminApiDenial();
  if (denied) return denied;
  const parsed = parseInput(query, { month: new URL(request.url).searchParams.get("month") ?? undefined });
  if (!parsed.ok) return new Response("Month must be YYYY-MM.", { status: 400 });
  const month = parseLedgerMonth(parsed.data.month, new Date());
  const ledger = await platformFeeLedger(month);
  return new Response(feeLedgerCsv(ledger), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="platform-fee-ledger-${month}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
