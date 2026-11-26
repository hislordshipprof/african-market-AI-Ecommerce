import Link from "next/link";
import { requireStoreMember } from "@/lib/store-admin/session";
import { formatListTime } from "@/lib/format";
import { getStoreThread, listStoreThreads } from "@/lib/support/thread";
import { Badge } from "@/components/ui/badge";
import { storeMayUse } from "@/lib/billing/plan";
import { ThreadReply } from "./thread-reply";
import { PageHeader } from "@/app/store-admin/shell/page-header";

export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ thread?: string }>;
}) {
  const session = await requireStoreMember();
  const { thread: threadId } = await searchParams;
  const owner = session.membership.role === "owner";
  const [threads, thread, assistant] = await Promise.all([
    listStoreThreads(session.store.id),
    threadId ? getStoreThread(session.store.id, threadId) : Promise.resolve(null),
    // Owner only: staff never see the store assistant (#820).
    owner ? storeMayUse(session.store.id, "store-assistant") : Promise.resolve(false),
  ]);
  const base = `/store-admin/messages?store=${encodeURIComponent(session.store.slug)}`;

  return (
    <>
      <PageHeader title="Messages" description={session.store.name} />
      <div className="grid gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <nav aria-label="Threads">
          {threads.length === 0 ? (
            <p className="text-sm text-muted-foreground">No messages yet. Customers write from their order tracking page.</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border bg-card">
              {threads.map((t) => (
                <li key={t.id}>
                  <Link
                    href={`${base}&thread=${t.id}`}
                    aria-current={t.id === thread?.id ? "page" : undefined}
                    className="flex min-h-11 items-center justify-between gap-3 px-4 py-3 hover:bg-muted aria-[current=page]:bg-muted"
                  >
                    <span>
                      <span className="block text-sm font-medium text-foreground">Order #{t.orderNumber}</span>
                      {t.lastCustomerAt && (
                        <span className="block text-xs text-muted-foreground">{formatListTime(t.lastCustomerAt, session.store.timezone)}</span>
                      )}
                    </span>
                    <span className="flex items-center gap-2">
                      {t.state === "escalated" && <Badge variant="destructive">Escalated</Badge>}
                      {t.unread > 0 && <Badge aria-label={`${t.unread} unread`}>{t.unread}</Badge>}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </nav>
        <section aria-label="Conversation">
          {thread ? (
            <div className="rounded-lg border border-border bg-card p-4">
              <h2 className="text-base font-semibold text-foreground">
                Order #{thread.orderNumber}
                {thread.customerName ? ` · ${thread.customerName}` : ""}
                {thread.state === "escalated" && <Badge variant="destructive" className="ml-2 align-middle">Escalated</Badge>}
              </h2>
              {thread.state === "escalated" && (
                <p className="mt-1 text-xs text-muted-foreground">The platform team can see this thread. Reply to take it back.</p>
              )}
              <ol className="my-4 grid gap-2">
                {thread.messages.map((m) => (
                  <li
                    key={m.id}
                    className={`max-w-[85%] rounded-lg border border-border px-3 py-2 ${m.sender === "customer" ? "justify-self-start" : "justify-self-end bg-muted"}`}
                  >
                    <span className="block text-xs text-muted-foreground">
                      {m.sender === "customer" ? "Customer" : m.sender === "platform" ? "Platform team" : m.senderName ?? "Store"} · {formatListTime(m.createdAt, session.store.timezone)}
                    </span>
                    <span className="whitespace-pre-wrap break-words text-sm text-foreground">{m.body}</span>
                  </li>
                ))}
              </ol>
              <ThreadReply threadId={thread.id} canSuggest={assistant && thread.messages.some((m) => m.sender === "customer")} />
            </div>
          ) : (
            threads.length > 0 && <p className="text-sm text-muted-foreground">Choose a thread to read and reply.</p>
          )}
        </section>
      </div>
    </>
  );
}
