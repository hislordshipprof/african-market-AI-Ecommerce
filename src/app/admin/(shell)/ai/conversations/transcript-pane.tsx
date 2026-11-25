import { FLAG_REASON_TEXT, KIND_TEXT, REVIEW_LABEL_TEXT, type TranscriptPart } from "@/lib/admin/ai-review";
import type { Transcript } from "@/lib/admin/ai-oversight";
import { formatInZone } from "@/lib/format";
import { ReviewButtons } from "./review-controls";

const ROLE_TEXT = { shopper: "Shopper", owner: "Store owner", admin: "Platform admin", assistant: "Assistant" } as const;

function when(iso: string, timeZone: string): string {
  return formatInZone(iso, timeZone, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

function dollars(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

function size(bytes: number | null): string {
  if (bytes === null) return "size unknown";
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

/** One chat: its turns, what the assistant did, and the review labels beside it. */
export function TranscriptPane({ transcript, nextUnlabelledHref }: { transcript: Transcript; nextUnlabelledHref: string | null }) {
  const zone = transcript.storeTimezone;
  const { kind } = transcript;

  return (
    <article aria-labelledby="chat-title" className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_14rem] xl:items-start">
      <header className="xl:col-start-1">
        <h2 id="chat-title" className="font-heading text-[22px] font-bold leading-tight text-foreground">
          {KIND_TEXT[kind]} chat · {transcript.storeName ?? "Platform"}
        </h2>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <Meta term="Started" value={when(transcript.createdAt, zone)} />
          <Meta term="Last message" value={when(transcript.lastMessageAt, zone)} />
          <Meta term="Model" value={transcript.model} />
          <Meta term="Cost" value={dollars(transcript.costMicros)} />
          {transcript.askedBy && <Meta term="Asked by" value={transcript.askedBy} />}
        </dl>
        <p className="mt-3 text-sm text-muted-foreground">
          Your view of this chat is recorded in the audit log.
          {kind === "shopper" && " Files shoppers sent are not stored; only their name, type and size are."}
        </p>
      </header>

      <section aria-labelledby="transcript-title" className="xl:col-start-1">
        <h3 id="transcript-title" className="sr-only">Transcript</h3>
        {transcript.messages.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-6 text-center text-muted-foreground">No messages stored.</p>
        ) : (
          <ol className="grid gap-3" data-testid="transcript">
            {transcript.messages.map((message) => {
              const mine = message.role === "assistant";
              return (
                <li key={message.id} className={`grid max-w-[88%] gap-1 ${mine ? "justify-self-start" : "justify-self-end"}`}>
                  <p className={`text-xs font-semibold text-muted-foreground ${mine ? "" : "text-right"}`}>{ROLE_TEXT[message.role]}</p>
                  <div className={`grid gap-2 rounded-2xl px-4 py-3 ${mine ? "rounded-tl-md border border-border bg-card" : "rounded-tr-md bg-secondary"}`}>
                    {message.parts.map((part, index) => (
                      <Part key={index} part={part} />
                    ))}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section
        aria-labelledby="labels-title"
        className="rounded-xl border border-border bg-card p-4 xl:sticky xl:top-6 xl:col-start-2 xl:row-span-3 xl:row-start-1"
      >
        <h3 id="labels-title" className="text-base font-semibold text-foreground">Label a mistake</h3>
        {transcript.flags.length > 0 && (
          <ul className="mt-3 grid gap-2" data-testid="review-labels">
            {transcript.flags.map((flag) => (
              <li key={flag.id} className="rounded-lg bg-muted px-3 py-2 text-sm">
                <span className="font-medium text-foreground">{REVIEW_LABEL_TEXT[flag.label]}</span>
                <span className="block break-words text-xs text-muted-foreground">{flag.createdByEmail} · {when(flag.createdAt, zone)}</span>
                {flag.note && <span className="mt-1 block whitespace-pre-wrap break-words text-foreground">{flag.note}</span>}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3">
          <ReviewButtons key={`${kind}:${transcript.id}`} kind={kind} conversationId={transcript.id} nextUnlabelledHref={nextUnlabelledHref} />
        </div>
      </section>

      <div className="xl:col-start-1">
        {kind === "shopper" && <ToolCalls transcript={transcript} />}
        {kind === "copilot" && <Proposals transcript={transcript} />}
      </div>
    </article>
  );
}

function Meta({ term, value }: { term: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="break-words font-medium text-foreground">{value}</dd>
    </div>
  );
}

function Part({ part }: { part: TranscriptPart }) {
  switch (part.kind) {
    case "text":
      return <p className="whitespace-pre-wrap break-words text-foreground">{part.text}</p>;
    case "attachment":
      return (
        <p className="text-sm text-muted-foreground">
          Sent a file: <span className="font-medium text-foreground">{part.name}</span> · {part.mediaType} · {size(part.bytes)}
          {part.pages !== null && ` · ${part.pages} ${part.pages === 1 ? "page" : "pages"}`} · not stored
        </p>
      );
    case "choices":
      return <p className="text-sm text-muted-foreground">Offered: {part.names.join(", ")}</p>;
    case "tool":
      return <JsonDetails summary={`Tool: ${part.tool}`} input={part.input} output={part.output} />;
    case "data":
      return <JsonDetails summary={`Card: ${part.type}`} output={part.data} />;
  }
}

function JsonDetails({ summary, input, output, extra }: { summary: React.ReactNode; input?: unknown; output: unknown; extra?: React.ReactNode }) {
  return (
    <details className="group rounded-lg border border-border bg-background text-sm">
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-1 font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        <span aria-hidden className="text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none">›</span>
        {summary}
        {extra}
      </summary>
      <div className="grid gap-2 border-t border-border px-3 py-2">
        {input !== undefined && (
          <div>
            <p className="text-xs font-semibold text-muted-foreground">Input</p>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs text-foreground">{json(input)}</pre>
          </div>
        )}
        <div>
          <p className="text-xs font-semibold text-muted-foreground">{input !== undefined ? "Output" : "Data"}</p>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs text-foreground">{json(output)}</pre>
        </div>
      </div>
    </details>
  );
}

function ToolCalls({ transcript }: { transcript: Transcript }) {
  return (
    <section aria-labelledby="actions-title">
      <h3 id="actions-title" className="mb-1 text-base font-semibold text-foreground">Tool calls</h3>
      <p className="mb-3 text-sm text-muted-foreground">Every tool call the assistant made, with prices the grounder removed and costly turns.</p>
      {transcript.actions.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-6 text-center text-muted-foreground">No tool calls stored.</p>
      ) : (
        <ol className="grid gap-2" data-testid="tool-calls">
          {transcript.actions.map((action) => (
            <li key={action.id}>
              <JsonDetails
                summary={
                  <span className="min-w-0 flex-1">
                    {action.tool}
                    <span className="font-normal text-muted-foreground"> · {action.ok ? "done" : "refused"} · {formatInZone(action.createdAt, transcript.storeTimezone, { hour: "numeric", minute: "2-digit", second: "2-digit" })}</span>
                  </span>
                }
                extra={action.reasons.map((reason) => (
                  <span key={reason} className="rounded-full border border-border px-2 py-0.5 text-xs font-medium text-foreground">
                    {FLAG_REASON_TEXT[reason]}
                  </span>
                ))}
                input={action.input}
                output={action.output}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const STATE_TEXT: Record<string, string> = { pending: "Waiting", confirmed: "Confirmed", rejected: "Rejected", expired: "Expired" };

function Proposals({ transcript }: { transcript: Transcript }) {
  return (
    <section aria-labelledby="proposals-title">
      <h3 id="proposals-title" className="mb-1 text-base font-semibold text-foreground">Stock changes drafted</h3>
      <p className="mb-3 text-sm text-muted-foreground">What the copilot proposed. Stock changed only for confirmed ones.</p>
      {transcript.proposals.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-6 text-center text-muted-foreground">No stock changes drafted.</p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card text-sm">
          {transcript.proposals.map((proposal) => (
            <li key={proposal.id} className="flex flex-wrap items-baseline gap-x-3 px-4 py-3">
              <span className="font-medium text-foreground">{proposal.listingName}</span>
              <span className="text-muted-foreground">
                {proposal.kind.replace("_", " ")}
                {proposal.quantity !== null && ` ${proposal.quantity}`}
                {proposal.statusValue && ` → ${proposal.statusValue.replaceAll("_", " ")}`}
              </span>
              <span className="text-muted-foreground">· {STATE_TEXT[proposal.state] ?? proposal.state}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
