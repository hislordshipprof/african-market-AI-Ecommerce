import Link from "next/link";
import { listEscalatedThreads } from "@/lib/support/platform-actions";
import { PlatformThreadActions } from "./thread-actions";

const TOPIC_LABEL: Record<string, string> = { order: "Order", payment: "Payment", delivery: "Delivery", app: "App" };
const REASON_LABEL: Record<string, string> = { topic: "Platform topic", sla: "No store reply in time" };
const SENDER_LABEL: Record<string, string> = { customer: "Customer", store: "Store", platform: "Platform team" };

const when = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));

function age(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

export default async function SupportQueuePage() {
  const threads = await listEscalatedThreads();

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Escalated messages</h1>
        <div className="flex items-center gap-4">
          <Link href="/admin/orders" className="text-sm text-primary underline">
            Refunds to resolve
          </Link>
          <Link href="/admin/stores" className="text-sm text-primary underline">
            Stores
          </Link>
        </div>
      </div>
      {threads.length === 0 ? (
        <p className="rounded-lg border border-input bg-card p-8 text-center text-muted-foreground">
          No escalated messages.
        </p>
      ) : (
        <ul className="space-y-4">
          {threads.map((thread) => (
            <li key={thread.id} className="rounded-lg border border-input bg-card p-4">
              <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
                <span className="font-medium text-foreground">{thread.storeName}</span>
                <span className="text-foreground">Order #{thread.orderNumber}</span>
                <span className="text-muted-foreground">{TOPIC_LABEL[thread.topic] ?? thread.topic}</span>
                <span className="text-muted-foreground">{REASON_LABEL[thread.escalationReason ?? ""] ?? "Escalated"}</span>
                <span className="text-muted-foreground tabular-nums">{age(thread.ageMinutes)} ago</span>
                <span className={thread.state === "escalated" ? "font-medium text-destructive" : "text-muted-foreground"}>
                  {thread.state === "escalated" ? "Waiting" : "Answered"}
                </span>
              </div>
              <ol className="mb-4 grid gap-2">
                {thread.messages.map((m) => (
                  <li key={m.id} className="rounded-md border border-input px-3 py-2">
                    <span className="block text-xs text-muted-foreground">
                      {m.sender === "customer" ? SENDER_LABEL.customer : `${SENDER_LABEL[m.sender]}${m.senderName ? ` · ${m.senderName}` : ""}`}
                      {" · "}
                      {when(m.createdAt, thread.storeTimezone)}
                    </span>
                    <span className="whitespace-pre-wrap break-words text-sm text-foreground">{m.body}</span>
                  </li>
                ))}
              </ol>
              <PlatformThreadActions threadId={thread.id} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
