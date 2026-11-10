import Link from "next/link";
import { Store } from "lucide-react";
import { requireStoreMember } from "@/lib/store-admin/session";
import { getStoreThread, listStoreThreads } from "@/lib/support/thread";
import { Badge } from "@/components/ui/badge";
import { ThreadReply } from "./thread-reply";

const when = (date: Date | string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(date));

export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ thread?: string }>;
}) {
  const session = await requireStoreMember();
  const { thread: threadId } = await searchParams;
  const [threads, thread] = await Promise.all([
    listStoreThreads(session.store.id),
    threadId ? getStoreThread(session.store.id, threadId) : Promise.resolve(null),
  ]);
  const base = `/store-admin/messages?store=${encodeURIComponent(session.store.slug)}`;

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-3">
          <Link
            href={`/store-admin?store=${session.store.slug}`}
            className="flex min-h-11 items-center gap-2 rounded-lg bg-primary px-3 text-primary-foreground"
          >
            <Store className="size-5" />
            <span className="text-sm font-semibold">Dashboard</span>
          </Link>
          <div>
            <h1 className="text-base font-semibold text-foreground">{session.store.name}</h1>
            <p className="text-xs text-muted-foreground">Messages</p>
          </div>
        </div>
      </header>
      <main className="mx-auto grid max-w-4xl gap-6 px-4 py-6 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
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
                        <span className="block text-xs text-muted-foreground">{when(t.lastCustomerAt)}</span>
                      )}
                    </span>
                    {t.unread > 0 && <Badge aria-label={`${t.unread} unread`}>{t.unread}</Badge>}
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
              </h2>
              <ol className="my-4 grid gap-2">
                {thread.messages.map((m) => (
                  <li
                    key={m.id}
                    className={`max-w-[85%] rounded-lg border border-border px-3 py-2 ${m.sender === "customer" ? "justify-self-start" : "justify-self-end bg-muted"}`}
                  >
                    <span className="block text-xs text-muted-foreground">
                      {m.sender === "customer" ? "Customer" : m.senderName ?? "Store"} · {when(m.createdAt)}
                    </span>
                    <span className="whitespace-pre-wrap break-words text-sm text-foreground">{m.body}</span>
                  </li>
                ))}
              </ol>
              <ThreadReply threadId={thread.id} />
            </div>
          ) : (
            threads.length > 0 && <p className="text-sm text-muted-foreground">Choose a thread to read and reply.</p>
          )}
        </section>
      </main>
    </div>
  );
}
