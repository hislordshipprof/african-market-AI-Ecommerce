import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { getCourierIncident } from "@/lib/admin/courier-incidents";
import { NOTE_MAX } from "@/lib/admin/courier-incidents-query";
import { formatAge } from "@/lib/admin/format-age";
import { EVENT_LABELS, PROVIDER_LABELS, StateLabel, kindsText, providersText, utcTime } from "../labels";
import { IncidentNoteForm } from "./note-form";

export const metadata = { title: "Courier incident — Platform Admin" };

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** The reason a courier gave, or why our failover ran, from an already redacted payload. */
function eventReason(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const data = p.data && typeof p.data === "object" ? (p.data as Record<string, unknown>) : {};
  const reason = [p.cancellation_reason, p.reason, data.undeliverable_reason, data.cancel_reason].find((v) => typeof v === "string" && v !== "");
  return typeof reason === "string" ? reason.replaceAll("_", " ") : null;
}

/** One courier incident (#536): what happened, the order's delivery timeline with contact details redacted, and notes. */
export default async function CourierIncidentPage(props: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await props.params;
  const detail = await getCourierIncident(orderId);
  if (!detail) notFound();
  const { incident, events, notes, checkedAt } = detail;

  return (
    <div className="max-w-3xl px-4 py-6 sm:px-6 lg:px-8">
      <Link href="/admin/couriers/incidents" className={`inline-flex min-h-11 items-center gap-1 rounded-full text-sm font-medium text-primary underline-offset-4 hover:underline ${FOCUS}`}>
        <ChevronLeft aria-hidden className="size-4" /> Courier incidents
      </Link>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <h1 className="font-heading text-[28px] font-bold leading-tight text-foreground">
          Order #{incident.orderNumber} <span className="font-normal text-muted-foreground">at {incident.storeName}</span>
        </h1>
        <StateLabel state={incident.state} />
      </div>

      <dl className="mt-6 grid gap-x-6 gap-y-3 rounded-xl border border-border bg-card p-4 text-sm sm:grid-cols-[max-content_1fr] sm:p-5">
        <dt className="text-muted-foreground">What happened</dt>
        <dd className="text-foreground" data-testid="incident-kinds">{kindsText(incident.kinds)}</dd>
        <dt className="text-muted-foreground">Courier</dt>
        <dd className="text-foreground">{providersText(incident.providers)}</dd>
        <dt className="text-muted-foreground">Opened</dt>
        <dd className="tabular-nums text-foreground">
          {formatAge(incident.openedAt, checkedAt.getTime())} ago, {utcTime(incident.openedAt)}
        </dd>
        <dt className="text-muted-foreground">Order status</dt>
        <dd className="text-foreground">
          {incident.orderStatus.toLowerCase().replaceAll("_", " ")}
          {incident.deliveryStatus && `, last delivery ${incident.deliveryStatus.replaceAll("_", " ")}`}
        </dd>
      </dl>

      <h2 className="mt-10 text-lg font-semibold text-foreground">Timeline</h2>
      <p className="mt-1 text-sm text-muted-foreground">Every delivery event on this order, oldest first. Phone numbers and the customer&apos;s contact details are removed.</p>
      <ol className="mt-4 divide-y divide-border rounded-xl border border-border bg-card" data-testid="incident-timeline">
        {events.map((event) => {
          const reason = eventReason(event.payload);
          return (
            <li key={event.id} className="grid gap-1 px-4 py-3 sm:grid-cols-[9rem_1fr] sm:gap-4 sm:px-5">
              <time dateTime={event.at.toISOString()} className="text-sm tabular-nums text-muted-foreground">{utcTime(event.at)}</time>
              <div className="min-w-0">
                <p className="text-sm text-foreground">
                  <span className="font-medium">{EVENT_LABELS[event.type] ?? event.type}</span>
                  {event.provider && <span className="text-muted-foreground">, {PROVIDER_LABELS[event.provider] ?? event.provider}</span>}
                </p>
                {reason && <p className="text-sm text-muted-foreground first-letter:uppercase">{reason}</p>}
                <details className="group mt-1 text-sm">
                  <summary className={`inline-flex min-h-11 cursor-pointer list-none items-center gap-1 rounded text-muted-foreground hover:text-foreground sm:min-h-8 [&::-webkit-details-marker]:hidden ${FOCUS}`}>
                    <ChevronRight aria-hidden className="size-4 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
                    Event details
                  </summary>
                  <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-muted p-3 text-xs leading-relaxed text-foreground">{JSON.stringify(event.payload, null, 2)}</pre>
                </details>
              </div>
            </li>
          );
        })}
      </ol>

      <h2 className="mt-10 text-lg font-semibold text-foreground">Notes</h2>
      {notes.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">No notes yet. Write what you checked or did, then resolve the incident when it needs nothing more.</p>
      ) : (
        <ol className="mt-4 space-y-3" data-testid="incident-notes">
          {notes.map((note) => (
            <li key={note.id} className="rounded-xl border border-border bg-card px-4 py-3 sm:px-5">
              <p className="text-sm text-muted-foreground">
                {note.authorEmail}, <time dateTime={note.createdAt.toISOString()}>{utcTime(note.createdAt)}</time>
                {note.resolves && <span className="ml-2 font-semibold text-foreground">Resolved</span>}
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words text-foreground">{note.body}</p>
            </li>
          ))}
        </ol>
      )}

      <IncidentNoteForm orderId={incident.orderId} max={NOTE_MAX} />
    </div>
  );
}
