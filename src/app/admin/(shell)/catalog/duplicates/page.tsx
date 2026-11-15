import { listDuplicatePairs } from "@/lib/admin/catalog-duplicates";
import { PairCard } from "./pair-card";
import { ScanForm } from "./scan-form";

export const metadata = { title: "Duplicates — Platform Admin" };

export default async function CatalogDuplicatesPage() {
  const pairs = await listDuplicatePairs();

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:py-12">
      <h1 className="font-heading text-[28px] font-bold leading-tight text-foreground">Duplicates</h1>
      <p className="mt-1 max-w-2xl text-muted-foreground">
        Products in the same category with similar names or a shared synonym. Merge moves every listing, synonym and recipe
        link to the product you keep and cannot be undone; the audit log keeps the record.
      </p>

      <ScanForm />

      <p className="mb-3 mt-8 text-sm text-muted-foreground" aria-live="polite" data-testid="duplicate-count">
        {pairs.length === 0
          ? "No possible duplicates. Find duplicates checks the catalog again."
          : `${pairs.length} possible ${pairs.length === 1 ? "duplicate" : "duplicates"}, most alike first`}
      </p>

      <ul className="grid gap-4">
        {pairs.map((pair) => (
          <li key={pair.id}>
            <PairCard pair={pair} />
          </li>
        ))}
      </ul>
    </div>
  );
}
