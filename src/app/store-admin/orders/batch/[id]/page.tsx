import { notFound } from "next/navigation";
import { requireStoreMember } from "@/lib/store-admin/session";
import { readPickBatch } from "@/lib/order/batch";
import { PackingScreen } from "./packing-screen";

/** The phone packing screen for one batch of orders (#564). Another store's batch is not found. */
export default async function BatchPackingPage({ params }: { params: Promise<{ id: string }> }) {
  const [session, { id }] = await Promise.all([requireStoreMember(), params]);
  const batch = await readPickBatch(session.store.id, id);
  if (!batch) notFound();
  return <PackingScreen initial={batch} storeParam={session.store.slug} timeZone={session.store.timezone} />;
}
