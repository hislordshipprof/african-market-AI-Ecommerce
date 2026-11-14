import Link from "next/link";
import { redirect } from "next/navigation";
import { requireStoreOwner } from "@/lib/store-admin/session";
import { storeMayUse } from "@/lib/billing/plan";
import { loadReorderList } from "@/lib/copilot/reorder-list";
import { PrintButton } from "./print-button";

const savedLabel = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" });

/** A plain page to print the saved reorder list (#551). */
export default async function ReorderPrintPage() {
  const session = await requireStoreOwner();
  const copilot = `/store-admin/copilot?store=${encodeURIComponent(session.store.slug)}`;
  const [allowed, list] = await Promise.all([
    storeMayUse(session.store.id, "reorder-suggestions"),
    loadReorderList(session.store.id),
  ]);
  if (!allowed || !list) redirect(copilot);

  return (
    <main className="mx-auto max-w-2xl bg-background px-4 py-6 text-foreground print:max-w-none print:px-0">
      <div className="mb-4 flex items-center justify-between gap-3 print:hidden">
        <Link href={copilot} className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline underline-offset-4">
          Back to copilot
        </Link>
        <PrintButton />
      </div>
      <h1 className="text-xl font-bold">{`Reorder list for ${session.store.name}`}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{`Saved ${savedLabel.format(list.savedAt)}`}</p>
      <table className="mt-4 w-full border-collapse text-base">
        <thead>
          <tr className="border-b border-border text-left">
            <th scope="col" className="py-2 font-semibold">Item</th>
            <th scope="col" className="py-2 text-right font-semibold">Quantity</th>
          </tr>
        </thead>
        <tbody>
          {list.items.map((item) => (
            <tr key={item.listingId} className="border-b border-border">
              <td className="py-2">{item.name}</td>
              <td className="py-2 text-right tabular-nums">{item.quantity ?? "Reorder (no count)"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
