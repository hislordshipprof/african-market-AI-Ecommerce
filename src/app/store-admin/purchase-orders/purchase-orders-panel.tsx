"use client";

import Link from "next/link";
import { useId, useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  archiveSupplierAction,
  draftPurchaseOrdersAction,
  editPurchaseOrderAction,
  movePurchaseOrderAction,
  saveSupplierAction,
  sendPurchaseOrderAction,
  setSupplierListingsAction,
} from "@/lib/purchasing/actions";
import type { PurchaseOrderView } from "@/lib/purchasing/purchase-orders";
import type { SupplierChannel, SupplierView } from "@/lib/purchasing/suppliers";

type OrderView = Omit<PurchaseOrderView, "sentAt" | "createdAt"> & { sentAt: string | null; createdAt: string };

const FIELD = "min-h-11 rounded-lg border border-border bg-background px-3 text-base text-foreground";
const INPUT = `${FIELD} w-full`;
const PILL = "min-h-11 rounded-full px-4";
const CHANNEL: Record<SupplierChannel, string> = { email: "Email", whatsapp: "WhatsApp", sms: "Text message" };
const SEND: Record<SupplierChannel, string> = { email: "Send by email", whatsapp: "Send on WhatsApp", sms: "Send by text" };
const STATUS: Record<OrderView["status"], string> = { draft: "Draft", sent: "Sent", received: "Received", cancelled: "Cancelled" };
const dateLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

function Notice({ text }: { text: string | null }) {
  return text ? <p role="status" className="text-sm text-muted-foreground">{text}</p> : null;
}

function OrderCard({ order }: { order: OrderView }) {
  const router = useRouter();
  const titleId = useId();
  const draft = order.status === "draft";
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(order.lines.map((line) => [line.id, line.quantity === null ? "" : String(line.quantity)])),
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function edits(): Array<{ lineId: string; quantity: number | null }> | null {
    const out = [];
    for (const line of order.lines) {
      const raw = (quantities[line.id] ?? "").trim();
      if (raw !== "" && !/^\d{1,6}$/.test(raw)) {
        setNotice(`Whole numbers only, for ${line.name}.`);
        return null;
      }
      out.push({ lineId: line.id, quantity: raw === "" ? null : Number(raw) });
    }
    return out;
  }

  function run(task: () => Promise<{ ok: boolean; message?: string }>, done: string) {
    startTransition(async () => {
      const result = await task();
      setNotice(result.ok ? done : (result.message ?? "Something went wrong."));
      if (result.ok) router.refresh();
    });
  }

  function save() {
    const lines = edits();
    if (lines) run(() => editPurchaseOrderAction({ orderId: order.id, lines }), "Saved.");
  }

  function send() {
    const lines = edits();
    if (!lines) return;
    startTransition(async () => {
      const saved = await editPurchaseOrderAction({ orderId: order.id, lines });
      if (!saved.ok) return setNotice(saved.message);
      const result = await sendPurchaseOrderAction({ orderId: order.id });
      if (!result.ok) return setNotice(result.message);
      setNotice(result.via === "email" ? `Emailed to ${order.supplier.name}.` : "Opening your messages app. Press send there.");
      if (result.link) window.location.href = result.link;
      router.refresh();
    });
  }

  const meta = [
    CHANNEL[order.supplier.channel],
    order.sentAt ? `sent ${dateLabel.format(new Date(order.sentAt))}` : `drafted ${dateLabel.format(new Date(order.createdAt))}`,
    `${order.supplier.leadDays}-day lead time`,
  ].join(" · ");

  return (
    <section aria-labelledby={titleId} className="rounded-xl border border-border bg-card">
      <div className="flex items-start justify-between gap-3 px-4 pt-4">
        <div className="min-w-0">
          <h3 id={titleId} className="truncate text-base font-semibold text-foreground">{`${order.supplier.name} · PO ${order.number}`}</h3>
          <p className="text-sm text-muted-foreground">{meta}</p>
        </div>
        <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground">{STATUS[order.status]}</span>
      </div>
      <ul className="mt-2 divide-y divide-border">
        {order.lines.map((line) => (
          <li key={line.id} className="flex items-center justify-between gap-3 px-4 py-2">
            <span className="min-w-0 truncate text-base text-foreground">{line.name}</span>
            {draft ? (
              <input
                aria-label={`Quantity of ${line.name}`}
                inputMode="numeric"
                placeholder="Qty"
                value={quantities[line.id] ?? ""}
                onChange={(e) => setQuantities((current) => ({ ...current, [line.id]: e.target.value }))}
                className={`${FIELD} w-24 shrink-0 text-right tabular-nums`}
              />
            ) : (
              <span className="shrink-0 text-base font-semibold text-foreground tabular-nums">{line.quantity ?? "No count"}</span>
            )}
          </li>
        ))}
      </ul>
      {draft || order.status === "sent" ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
          {draft ? (
            <>
              <Button type="button" className={PILL} disabled={pending} onClick={send}>{SEND[order.supplier.channel]}</Button>
              <Button type="button" variant="outline" className={PILL} disabled={pending} onClick={save}>Save changes</Button>
            </>
          ) : (
            <Button type="button" className={PILL} disabled={pending} onClick={() => run(() => movePurchaseOrderAction({ orderId: order.id, to: "received" }), "Marked received.")}>
              Mark received
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            className={PILL}
            disabled={pending}
            onClick={() => {
              if (window.confirm(`Cancel PO ${order.number} to ${order.supplier.name}?`)) {
                run(() => movePurchaseOrderAction({ orderId: order.id, to: "cancelled" }), "Cancelled.");
              }
            }}
          >
            Cancel order
          </Button>
          {draft ? <p className="basis-full text-sm text-muted-foreground">0 takes an item off. A blank must be filled before sending.</p> : null}
          <Notice text={notice} />
        </div>
      ) : null}
    </section>
  );
}

function SupplierForm({ supplier, onDone }: { supplier: SupplierView | null; onDone: () => void }) {
  const router = useRouter();
  const id = useId();
  const [form, setForm] = useState({
    name: supplier?.name ?? "",
    contactName: supplier?.contactName ?? "",
    email: supplier?.email ?? "",
    phone: supplier?.phone ?? "",
    channel: supplier?.channel ?? ("whatsapp" as SupplierChannel),
    leadDays: String(supplier?.leadDays ?? 7),
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((current) => ({ ...current, [key]: e.target.value }));

  function save(event: React.FormEvent) {
    event.preventDefault();
    if (!/^\d{1,2}$/.test(form.leadDays.trim())) return setNotice("Lead time is whole days, 0 to 90.");
    startTransition(async () => {
      const result = await saveSupplierAction({ id: supplier?.id ?? null, supplier: { ...form, leadDays: Number(form.leadDays) } });
      if (!result.ok) return setNotice(result.message);
      router.refresh();
      onDone();
    });
  }

  const field = "flex flex-col gap-1 text-sm text-muted-foreground";
  return (
    <form onSubmit={save} className="grid gap-3 px-4 py-4 sm:grid-cols-2">
      <label htmlFor={`${id}-name`} className={field}>
        Business name
        <input id={`${id}-name`} required maxLength={120} value={form.name} onChange={set("name")} className={INPUT} autoComplete="organization" />
      </label>
      <label htmlFor={`${id}-contact`} className={field}>
        Contact person (optional)
        <input id={`${id}-contact`} maxLength={120} value={form.contactName} onChange={set("contactName")} className={INPUT} autoComplete="name" />
      </label>
      <label htmlFor={`${id}-phone`} className={field}>
        Phone
        <input id={`${id}-phone`} type="tel" maxLength={40} value={form.phone} onChange={set("phone")} className={INPUT} autoComplete="tel" placeholder="(214) 555-0123 or +234…" />
      </label>
      <label htmlFor={`${id}-email`} className={field}>
        Email
        <input id={`${id}-email`} type="email" maxLength={254} value={form.email} onChange={set("email")} className={INPUT} autoComplete="email" />
      </label>
      <label htmlFor={`${id}-channel`} className={field}>
        Send orders by
        <select id={`${id}-channel`} value={form.channel} onChange={set("channel")} className={INPUT}>
          <option value="whatsapp">WhatsApp, from your phone</option>
          <option value="sms">Text message, from your phone</option>
          <option value="email">Email, sent for you</option>
        </select>
      </label>
      <label htmlFor={`${id}-lead`} className={field}>
        Lead time (days)
        <input id={`${id}-lead`} inputMode="numeric" value={form.leadDays} onChange={set("leadDays")} className={`${INPUT} tabular-nums`} />
      </label>
      <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
        <Button type="submit" className={PILL} disabled={pending}>{supplier ? "Save supplier" : "Add supplier"}</Button>
        <Button type="button" variant="ghost" className={PILL} onClick={onDone}>Close</Button>
        <Notice text={notice} />
      </div>
    </form>
  );
}

function ItemsPicker({ supplier, listings, supplierOf }: { supplier: SupplierView; listings: Array<{ id: string; name: string }>; supplierOf: Map<string, { id: string; name: string }> }) {
  const router = useRouter();
  const [picked, setPicked] = useState(() => new Set(supplier.listingIds));
  const [filter, setFilter] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const shown = listings.filter((listing) => listing.name.toLowerCase().includes(filter.trim().toLowerCase()));

  function toggle(listingId: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(listingId)) next.add(listingId);
      return next;
    });
  }

  function save() {
    startTransition(async () => {
      const result = await setSupplierListingsAction({ supplierId: supplier.id, listingIds: [...picked] });
      setNotice(result.ok ? "Items saved." : result.message);
      if (result.ok) router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <input aria-label={`Find items for ${supplier.name}`} type="search" placeholder="Find an item" value={filter} onChange={(e) => setFilter(e.target.value)} className={INPUT} />
      <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-lg border border-border">
        {shown.map((listing) => {
          const other = supplierOf.get(listing.id);
          return (
            <li key={listing.id}>
              <label className="flex min-h-11 items-center gap-3 px-3 py-2 text-base text-foreground">
                <input type="checkbox" className="size-5 accent-primary" checked={picked.has(listing.id)} onChange={() => toggle(listing.id)} />
                <span className="min-w-0 flex-1 truncate">{listing.name}</span>
                {other && other.id !== supplier.id && !picked.has(listing.id) ? <span className="shrink-0 text-xs text-muted-foreground">{other.name}</span> : null}
              </label>
            </li>
          );
        })}
        {shown.length === 0 ? <li className="px-3 py-3 text-sm text-muted-foreground">No items match.</li> : null}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" className={PILL} disabled={pending} onClick={save}>{`Save ${picked.size} ${picked.size === 1 ? "item" : "items"}`}</Button>
        <Notice text={notice} />
      </div>
      <p className="text-sm text-muted-foreground">Each item has one supplier. Picking an item another supplier has moves it here.</p>
    </div>
  );
}

function SupplierCard({ supplier, listings, supplierOf }: { supplier: SupplierView; listings: Array<{ id: string; name: string }>; supplierOf: Map<string, { id: string; name: string }> }) {
  const router = useRouter();
  const titleId = useId();
  const [open, setOpen] = useState<"edit" | "items" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const contact = supplier.channel === "email" ? supplier.email : supplier.phone;
  const count = supplier.listingIds.length;

  function remove() {
    if (!window.confirm(`Remove ${supplier.name}? Its items go back to no supplier.`)) return;
    startTransition(async () => {
      const result = await archiveSupplierAction({ supplierId: supplier.id });
      if (!result.ok) return setNotice(result.message);
      router.refresh();
    });
  }

  return (
    <section aria-labelledby={titleId} className="rounded-xl border border-border bg-card">
      <div className="px-4 pt-4">
        <h3 id={titleId} className="text-base font-semibold text-foreground">{supplier.name}</h3>
        <p className="text-sm text-muted-foreground">
          {[`${CHANNEL[supplier.channel]} ${contact ?? ""}`.trim(), supplier.contactName, `${supplier.leadDays}-day lead time`, `${count} ${count === 1 ? "item" : "items"}`].filter(Boolean).join(" · ")}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <Button type="button" variant="outline" className={PILL} aria-expanded={open === "items"} onClick={() => setOpen(open === "items" ? null : "items")}>Items</Button>
        <Button type="button" variant="outline" className={PILL} aria-expanded={open === "edit"} onClick={() => setOpen(open === "edit" ? null : "edit")}>Edit</Button>
        <Button type="button" variant="ghost" className={PILL} disabled={pending} onClick={remove}>Remove</Button>
        <Notice text={notice} />
      </div>
      {open === "edit" ? <div className="border-t border-border"><SupplierForm supplier={supplier} onDone={() => setOpen(null)} /></div> : null}
      {open === "items" ? <div className="border-t border-border"><ItemsPicker supplier={supplier} listings={listings} supplierOf={supplierOf} /></div> : null}
    </section>
  );
}

export function PurchaseOrdersPage({
  storeName,
  storeSlug,
  locked,
  suppliers = [],
  orders = [],
  listings = [],
  listSavedAt = null,
}: {
  storeName: string;
  storeSlug: string;
  locked?: React.ReactNode;
  suppliers?: SupplierView[];
  orders?: OrderView[];
  listings?: Array<{ id: string; name: string }>;
  listSavedAt?: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const store = encodeURIComponent(searchParams.get("store") ?? storeSlug);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const supplierOf = useMemo(
    () => new Map(suppliers.flatMap((supplier) => supplier.listingIds.map((listingId) => [listingId, { id: supplier.id, name: supplier.name }] as const))),
    [suppliers],
  );

  function draft() {
    startTransition(async () => {
      const result = await draftPurchaseOrdersAction();
      if (!result.ok) return setNotice(result.message);
      const drafted = `${result.drafted} draft ${result.drafted === 1 ? "order" : "orders"} ready. Check them, then send.`;
      setNotice(result.unassigned.length ? `${drafted} No supplier yet, left out: ${result.unassigned.join(", ")}.` : drafted);
      router.refresh();
    });
  }

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          <Link href={`/store-admin?store=${store}`} aria-label="Back to store admin" className={buttonVariants({ variant: "ghost", size: "icon", className: "size-11" })}>
            <ArrowLeft className="size-4" />
          </Link>
          <div>
            <h1 className="text-base font-semibold text-foreground">Purchase orders</h1>
            <p className="text-xs text-muted-foreground">{storeName}</p>
          </div>
        </div>
      </header>
      <main className="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-6">
        {locked ?? (
          <>
            <section aria-labelledby="orders-title" className="flex flex-col gap-3">
              <div>
                <h2 id="orders-title" className="font-display text-[1.375rem] leading-tight font-bold text-balance text-foreground">Orders to wholesalers</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {listSavedAt
                    ? `Your reorder list, saved ${dateLabel.format(new Date(listSavedAt))}, becomes one draft order per supplier. Email is sent for you from ${storeName}. WhatsApp and text open on your phone with the order written out, and you press send.`
                    : "Save a reorder list on the Copilot page first. It becomes one draft order per supplier."}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {listSavedAt ? (
                  <Button type="button" className={PILL} disabled={pending || suppliers.length === 0} onClick={draft}>
                    {pending ? "Drafting…" : "Draft orders from reorder list"}
                  </Button>
                ) : null}
                <Link href={`/store-admin/copilot?store=${store}`} className={buttonVariants({ variant: "outline", className: PILL })}>
                  {listSavedAt ? "Edit reorder list" : "Go to reorder list"}
                </Link>
                <Notice text={notice} />
              </div>
              {orders.length === 0 ? (
                <p className="rounded-xl border border-border bg-card px-4 py-4 text-base text-muted-foreground">No purchase orders yet.</p>
              ) : (
                orders.map((order) => <OrderCard key={`${order.id}-${order.status}-${order.lines.map((l) => `${l.id}:${l.quantity}`).join(",")}`} order={order} />)
              )}
            </section>

            <section aria-labelledby="suppliers-title" className="flex flex-col gap-3">
              <div>
                <h2 id="suppliers-title" className="font-display text-[1.375rem] leading-tight font-bold text-balance text-foreground">Suppliers</h2>
                <p className="mt-1 text-sm text-muted-foreground">Who you buy from, how they take orders, and which of your items each one supplies.</p>
              </div>
              {suppliers.map((supplier) => <SupplierCard key={supplier.id} supplier={supplier} listings={listings} supplierOf={supplierOf} />)}
              {adding ? (
                <div className="rounded-xl border border-border bg-card">
                  <SupplierForm supplier={null} onDone={() => setAdding(false)} />
                </div>
              ) : (
                <div>
                  <Button type="button" variant={suppliers.length === 0 ? "default" : "outline"} className={PILL} onClick={() => setAdding(true)}>Add supplier</Button>
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
