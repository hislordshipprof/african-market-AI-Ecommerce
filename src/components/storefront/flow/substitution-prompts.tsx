"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { answerSubstitutionAction } from "@/lib/order/substitution-actions";
import type { SubstitutionPromptView } from "@/lib/order/substitution";
import { Button } from "../primitives";
import { FlowCard, FlowError } from "./common";
import { money } from "@/lib/format";
import "./order-flow.css";

const REFRESH_MS = 5000;

function countdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function outcomeCopy(prompt: SubstitutionPromptView): string {
  const timedOut = prompt.status === "timed_out" ? " Your swap preference was applied when the time ran out." : "";
  if (prompt.outcome === "swap") return `Swapped for ${prompt.proposed?.name ?? "the suggested item"}.${timedOut}`;
  return `Refunded: you won't be charged for ${prompt.qty} × ${prompt.original.name}.${timedOut}`;
}

/** The real prompt for a short line, opened by the order's tracking token (#13). */
export function SubstitutionPrompts({ token, prompts: initial }: { token: string; prompts: SubstitutionPromptView[] }) {
  const router = useRouter();
  const [prompts, setPrompts] = useState(initial);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const waiting = prompts.some((prompt) => prompt.status === "pending");

  useEffect(() => {
    if (!waiting) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    // A timed-out answer is applied on the server; refresh picks it up.
    const refresh = window.setInterval(() => router.refresh(), REFRESH_MS);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(refresh);
    };
  }, [waiting, router]);

  async function answer(requestId: string, decision: "swap" | "refund") {
    setBusy(requestId);
    try {
      const result = await answerSubstitutionAction({ token, requestId, decision });
      if (result.prompts) setPrompts(result.prompts);
      setError(result.ok ? "" : result.error);
    } catch {
      setError("We couldn't save your choice. Try again.");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="of-stack">
      {prompts.map((prompt) => {
        const seconds = Math.max(0, Math.ceil((Date.parse(prompt.expiresAt) - now) / 1000));
        const pending = prompt.status === "pending";
        return (
          <FlowCard key={prompt.id} title={pending ? `${prompt.original.name} is short` : "Answered"}>
            <p>
              The store found {prompt.qty} fewer {prompt.qty === 1 ? "item" : "items"} than you ordered.
              {prompt.proposed
                ? " They suggest:"
                : prompt.exactOnly
                  ? " You asked for this exact item only, so we'll refund it."
                  : " No swap in stock fits your card hold, so we'll refund it."}
            </p>
            <div className="of-swap">
              <div className="of-line">
                <div>
                  <small>Not found · {prompt.qty}</small>
                  <strong>{prompt.original.name}</strong>
                  <p>{money(prompt.qty * prompt.original.unitPriceCents)}</p>
                </div>
              </div>
              {prompt.proposed && (
                <div className="of-line">
                  <div>
                    <small>Swap for · {prompt.qty}</small>
                    <strong>{prompt.proposed.name}</strong>
                    <p>{money(prompt.qty * prompt.proposed.unitPriceCents)}</p>
                  </div>
                </div>
              )}
            </div>
            {prompt.proposed && (
              <p>
                <strong>{prompt.deltaCents > 0 ? "+" : ""}{money(prompt.deltaCents)}</strong> difference for this item.
                {prompt.deltaCents > 0 && " It stays within your card hold."}
              </p>
            )}
            {pending ? (
              <>
                <p>
                  {seconds > 0 ? (
                    <>Answer within <strong suppressHydrationWarning>{countdown(seconds)}</strong>. </>
                  ) : (
                    <>Time is up. </>
                  )}
                  If you don&rsquo;t answer, we&rsquo;ll {prompt.proposed ? "make the swap" : "refund this item"}.
                </p>
                <div className="of-actions">
                  {prompt.proposed && (
                    <Button disabled={busy === prompt.id || seconds === 0} onClick={() => answer(prompt.id, "swap")}>
                      Swap
                    </Button>
                  )}
                  <Button disabled={busy === prompt.id || seconds === 0} onClick={() => answer(prompt.id, "refund")}>
                    Refund this item
                  </Button>
                </div>
              </>
            ) : (
              <p role="status">{outcomeCopy(prompt)}</p>
            )}
          </FlowCard>
        );
      })}
      {error && <FlowError message={error} />}
    </div>
  );
}
