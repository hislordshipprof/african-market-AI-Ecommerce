import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { readTranscript, type Transcript } from "@/lib/admin/ai-oversight";
import { FLAG_REASON_TEXT, REVIEW_LABEL_TEXT, type TranscriptPart } from "@/lib/admin/ai-review";
import { formatInZone } from "@/lib/format";
import { LabelForm } from "./label-form";

export const metadata = { title: "AI conversation — Platform Admin" };

const ROLE_TEXT = { shopper: "Shopper", owner: "Store owner", assistant: "Assistant" } as const;

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

export default async function AiConversationPage({ params }: { params: Promise<{ kind: string; id: string }> }) {
  const { kind, id } = await params;
  if (kind !== "shopper" && kind !== "copilot") notFound();
  const transcript = await readTranscript({ kind, id });
  if (!transcript) notFound();
  const zone = transcript.storeTimezone;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:py-12">
      <Link
        href="/admin/ai/conversations"
        className="mb-4 inline-flex min-h-11 items-center gap-1 rounded-full pr-3 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <ChevronLeft aria-hidden className="size-4" /> AI conversations
      </Link>
      <h1 className="font-heading text-[28px] font-bold leading-tight text-foreground">
        {kind === "shopper" ? "Shopper chat" : "Copilot chat"} · {transcript.storeName}
      </h1>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <Meta term="Started" value={when(transcript.createdAt, zone)} />
        <Meta term="Last message" value={when(transcript.lastMessageAt, zone)} />
        <Meta term="Model" value={transcript.model} />
        <Meta term="Cost" value={dollars(transcript.costMicros)} />
      </dl>
      <p className="mt-3 text-sm text-muted-foreground">
        Your view of this chat is recorded in the audit log. Files people sent are not stored; only their name, type and size are.
      </p>

      <section aria-labelledby="labels-title" className="mt-8 rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 id="labels-title" className="text-lg font-semibold text-foreground">Review</h2>
        {transcript.flags.length > 0 && (
          <ul className="mb-5 mt-3 grid gap-2" data-testid="review-labels">
            {transcript.flags.map((flag) => (
              <li key={flag.id} className="rounded-lg border border-border px-3 py-2 text-sm">
                <span className="font-medium text-foreground">{REVIEW_LABEL_TEXT[flag.label]}</span>
                <span className="text-muted-foreground"> · {flag.createdByEmail} · {when(flag.createdAt, zone)}</span>
                {flag.note && <span className="mt-1 block whitespace-pre-wrap break-words text-foreground">{flag.note}</span>}
              </li>
            ))}
          </ul>
        )}
        <div className={transcript.flags.length > 0 ? "" : "mt-3"}>
          <LabelForm kind={kind} conversationId={transcript.id} />
        </div>
      </section>

      <section aria-labelledby="transcript-title" className="mt-8">
        <h2 id="transcript-title" className="mb-3 text-lg font-semibold text-foreground">Transcript</h2>
        {transcript.messages.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">No messages stored.</p>
        ) : (
          <ol className="grid gap-3" data-testid="transcript">
            {transcript.messages.map((message) => (
              <li
                key={message.id}
                className={`rounded-xl border border-border px-4 py-3 ${message.role === "assistant" ? "bg-card" : "bg-muted"}`}
              >
                <p className="mb-1 text-xs font-semibold text-muted-foreground">{ROLE_TEXT[message.role]}</p>
                <div className="grid gap-2">
                  {message.parts.map((part, index) => (
                    <Part key={index} part={part} />
                  ))}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {kind === "shopper" ? <ToolCalls transcript={transcript} /> : <Proposals transcript={transcript} />}
    </div>
  );
}

function Meta({ term, value }: { term: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="truncate font-medium text-foreground" title={value}>{value}</dd>
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
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        <span aria-hidden className="text-muted-foreground transition-transform group-open:rotate-90">›</span>
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
    <section aria-labelledby="actions-title" className="mt-8">
      <h2 id="actions-title" className="mb-1 text-lg font-semibold text-foreground">Tool calls</h2>
      <p className="mb-3 text-sm text-muted-foreground">Every tool call the assistant made, with prices the grounder removed and costly turns.</p>
      {transcript.actions.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">No tool calls stored.</p>
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
    <section aria-labelledby="proposals-title" className="mt-8">
      <h2 id="proposals-title" className="mb-1 text-lg font-semibold text-foreground">Stock changes drafted</h2>
      <p className="mb-3 text-sm text-muted-foreground">What the copilot proposed. Stock changed only for confirmed ones.</p>
      {transcript.proposals.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">No stock changes drafted.</p>
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
