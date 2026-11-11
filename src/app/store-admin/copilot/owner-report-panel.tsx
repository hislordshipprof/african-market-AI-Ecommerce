"use client";

import { useRef, useState, useSyncExternalStore, useTransition } from "react";
import { CircleAlert, Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  beginSpeech,
  bindRecognizer,
  noteCustomerEdit,
  recognitionLanguage,
  sealSpeech,
  stopSpeech,
  type BrowserSpeech,
  type SpeechState,
} from "@/lib/assistant/ui/speech";
import type { OwnerReportCard, OwnerReportItemCard } from "@/lib/copilot/owner-report";
import { jpegBlob } from "@/lib/image/client-jpeg";
import { confirmOwnerReportItems, submitPhotoReport, submitVoiceReport } from "@/lib/copilot/report-actions";

type SpeechHost = Window & {
  SpeechRecognition?: new () => BrowserSpeech;
  webkitSpeechRecognition?: new () => BrowserSpeech;
};

const ITEM_STATE: Record<OwnerReportItemCard["status"], string> = {
  pending: "Waiting for you",
  confirmed: "Added to stock",
  rejected: "Not applied",
  unmatched: "No listing found",
};

function change(item: OwnerReportItemCard): string {
  if (item.kind === "set_status") return `${(item.stockStatus ?? "unknown").replaceAll("_", " ")} → in stock`;
  return `${item.qty ?? 0} → ${(item.qty ?? 0) + (item.proposedDelta ?? 0)}`;
}

function reported(item: OwnerReportItemCard): string {
  if (item.extractedQty === null) return "No clear quantity";
  return `${item.extractedQty}${item.unit ? ` ${item.unit}` : ""}`;
}

/**
 * Voice note or photo in; matched lines to tick, unmatched lines to read. Stock changes only on Confirm.
 * `submitOnly` (staff on the dashboard) sends the report and leaves confirming to the owner.
 */
export function OwnerReportPanel({ pending: waiting = [], submitOnly = false }: { pending?: OwnerReportCard[]; submitOnly?: boolean }) {
  const [text, setText] = useState("");
  const [speech, setSpeech] = useState<SpeechState | null>(null);
  const [photoType, setPhotoType] = useState<"invoice_photo" | "shelf_photo">("invoice_photo");
  const [reports, setReports] = useState<OwnerReportCard[]>(waiting);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const speechRef = useRef<SpeechState | null>(null);
  const recognizerRef = useRef<BrowserSpeech | null>(null);
  const photoRef = useRef<HTMLInputElement>(null);

  const canListen = useSyncExternalStore(
    () => () => {},
    () => Boolean((window as SpeechHost).SpeechRecognition ?? (window as SpeechHost).webkitSpeechRecognition),
    () => false,
  );

  function publish(next: SpeechState) {
    speechRef.current = next;
    setSpeech(next);
    setText(next.draft);
  }

  function toggleRecord() {
    if (speechRef.current?.listening) {
      recognizerRef.current?.stop();
      publish(stopSpeech(speechRef.current));
      return;
    }
    const host = window as SpeechHost;
    const Ctor = host.SpeechRecognition ?? host.webkitSpeechRecognition;
    if (!Ctor) return;
    const started = beginSpeech(text, (speechRef.current?.session ?? 0) + 1);
    publish(started);
    if (!started.accepting) return;
    const recognizer = new Ctor();
    recognizerRef.current = recognizer;
    try {
      bindRecognizer(recognizer, {
        lang: recognitionLanguage(document.documentElement.lang, navigator.language),
        session: started.session,
        read: () => speechRef.current ?? started,
        write: publish,
      });
    } catch {
      publish(stopSpeech(started));
      setError("Microphone access is off. You can type instead.");
    }
  }

  function showReport(next: OwnerReportCard) {
    if (submitOnly) return setSent(true);
    setReports((current) => [next, ...current.filter((report) => report.id !== next.id)]);
  }

  function sendVoice() {
    if (speechRef.current) {
      recognizerRef.current?.stop();
      speechRef.current = sealSpeech(speechRef.current);
      setSpeech(speechRef.current);
    }
    setError(null);
    setSent(false);
    startTransition(async () => {
      const result = await submitVoiceReport({ transcript: text });
      if (!result.ok) return setError(result.message);
      setText("");
      showReport(result.report);
    });
  }

  function sendPhoto() {
    const file = photoRef.current?.files?.[0];
    if (!file) return setError("Choose a photo first.");
    setError(null);
    setSent(false);
    startTransition(async () => {
      let jpeg: Blob;
      try {
        jpeg = await jpegBlob(file);
      } catch {
        return setError("This browser can't read that photo. Take it again or choose another one.");
      }
      const form = new FormData();
      form.set("type", photoType);
      form.set("photo", new File([jpeg], "report.jpg", { type: "image/jpeg" }));
      const result = await submitPhotoReport(form);
      if (!result.ok) return setError(result.message);
      if (photoRef.current) photoRef.current.value = "";
      showReport(result.report);
    });
  }

  const listening = speech?.listening ?? false;

  return (
    <section
      aria-label="Voice and photo reports"
      className={submitOnly ? "flex flex-col gap-4" : "mt-10 flex flex-col gap-4 border-t border-border pt-8"}
    >
      <h2 className="font-display text-[1.375rem] leading-tight font-bold text-foreground">Report stock by voice or photo</h2>
      <p className="max-w-[65ch] text-base leading-6 text-muted-foreground">
        Say what came in, or snap the supplier invoice or a shelf. Nothing changes until {submitOnly ? "the owner confirms" : "you confirm"}.
      </p>

      <label htmlFor="owner-report-voice" className="text-[0.8125rem] font-semibold text-foreground">Voice note</label>
      <textarea
        id="owner-report-voice"
        value={text}
        maxLength={1000}
        rows={2}
        placeholder="Got 20 bags of egusi and 15 bottles of palm oil"
        onChange={(event) => {
          setText(event.target.value);
          if (speechRef.current) publish(noteCustomerEdit(speechRef.current, event.target.value));
        }}
        className="w-full resize-none rounded-xl border border-border bg-card px-3 py-3 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      <div className="flex flex-wrap gap-2">
        {canListen && (
          <Button type="button" variant="outline" onClick={toggleRecord} disabled={pending} className="min-h-12 rounded-full px-5">
            {listening ? <Square className="size-4" aria-hidden="true" /> : <Mic className="size-4" aria-hidden="true" />}
            {listening ? "Stop" : "Record"}
          </Button>
        )}
        <Button type="button" onClick={sendVoice} disabled={pending || listening || !text.trim()} className="min-h-12 rounded-full px-6">
          Read voice note
        </Button>
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-[0.8125rem] font-semibold text-foreground">Photo</legend>
        <div className="flex flex-wrap gap-4 text-sm text-foreground">
          {(["invoice_photo", "shelf_photo"] as const).map((type) => (
            <label key={type} className="flex min-h-11 items-center gap-2">
              <input type="radio" name="owner-report-type" checked={photoType === type} onChange={() => setPhotoType(type)} />
              {type === "invoice_photo" ? "Supplier invoice" : "Shelf"}
            </label>
          ))}
        </div>
        <input ref={photoRef} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="text-sm" />
        <Button type="button" onClick={sendPhoto} disabled={pending} className="min-h-12 self-start rounded-full px-6">
          Read photo
        </Button>
      </fieldset>

      {error && (
        <p className="flex items-start gap-2 text-sm text-destructive" role="alert">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}

      {sent && (
        <p className="text-sm text-foreground" role="status">Sent. The owner confirms it on the copilot page.</p>
      )}

      {!submitOnly && reports.map((report) => (
        <ReportView
          key={report.id}
          report={report}
          onSettled={(next) => setReports((current) => current.map((item) => (item.id === next.id ? next : item)))}
        />
      ))}
    </section>
  );
}

function ReportView({ report, onSettled }: { report: OwnerReportCard; onSettled: (report: OwnerReportCard) => void }) {
  const [ticked, setTicked] = useState<Set<string>>(
    () => new Set(report.items.filter((item) => item.status === "pending").map((item) => item.id)),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const matched = report.items.filter((item) => item.listingId);
  const unmatched = report.items.filter((item) => !item.listingId);
  const open = report.status === "pending";

  function decide(itemIds: string[]) {
    setError(null);
    startTransition(async () => {
      const result = await confirmOwnerReportItems({ reportId: report.id, itemIds });
      if (result.ok) return onSettled(result.report);
      setError(result.code === "failed" ? "That didn't go through. Try again." : "That report was already settled. Send a new one.");
    });
  }

  return (
    <div className="flex flex-col gap-4 border-t border-border pt-4" aria-live="polite">
      {report.items.length === 0 && (
        <p className="rounded-xl border border-border bg-card px-4 py-5 text-base text-muted-foreground">
          No items found in that report. Try again with the item names and numbers.
        </p>
      )}
      {matched.length > 0 && (
        <section aria-label="Proposed stock changes" className="flex flex-col gap-3">
          {matched.map((item) => (
            <label key={item.id} className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-4">
              {open && item.status === "pending" && (
                <input
                  type="checkbox"
                  className="mt-1.5 size-5"
                  checked={ticked.has(item.id)}
                  onChange={(event) => {
                    const next = new Set(ticked);
                    if (event.target.checked) next.add(item.id);
                    else next.delete(item.id);
                    setTicked(next);
                  }}
                />
              )}
              <span className="flex flex-col">
                <span className="font-display text-xl leading-tight font-bold text-foreground">{item.listingName}</span>
                <span className="mt-2 font-display text-[1.75rem] leading-none font-bold tracking-tight text-foreground tabular-nums">
                  {change(item)}
                </span>
                <span className="mt-2 text-sm text-muted-foreground">
                  Heard “{item.extractedName}” · {reported(item)} · {item.matchConfidence < 1 ? "Check this match" : "Clear match"}
                  {open ? "" : ` · ${ITEM_STATE[item.status]}`}
                </span>
              </span>
            </label>
          ))}
        </section>
      )}
      {unmatched.length > 0 && (
        <section aria-label="Unmatched items" className="flex flex-col gap-2">
          <h3 className="text-base font-semibold text-foreground">Unmatched items</h3>
          <p className="text-sm text-muted-foreground">
            No listing or no clear quantity for these. Add missing items in Products, then report them again with a number.
          </p>
          <ul className="flex flex-col gap-2">
            {unmatched.map((item) => (
              <li key={item.id} className="rounded-xl border border-dashed border-border px-4 py-3 text-base text-foreground">
                {item.extractedName} <span className="text-muted-foreground">· {reported(item)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {report.overflow && (
        <p className="text-sm text-muted-foreground">That report had more than 30 lines. Send the rest as a new report.</p>
      )}
      {error && (
        <p className="flex items-start gap-2 text-sm text-destructive" role="alert">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
      {open && (
        <div className="flex flex-wrap gap-2">
          {matched.length > 0 && (
            <Button type="button" onClick={() => decide([...ticked])} disabled={pending || ticked.size === 0} className="min-h-12 rounded-full px-6">
              {ticked.size === matched.length ? "Confirm all" : `Confirm ${ticked.size}`}
            </Button>
          )}
          <Button type="button" variant="outline" onClick={() => decide([])} disabled={pending} className="min-h-12 rounded-full px-6">
            Dismiss report
          </Button>
        </div>
      )}
    </div>
  );
}
