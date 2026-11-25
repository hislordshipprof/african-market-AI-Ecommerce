import { OrdersView } from "../page";

/** One order's panel beside the order list (#860); links from Home, search and alerts land here. */
export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OrdersView selectedId={id} />;
}
