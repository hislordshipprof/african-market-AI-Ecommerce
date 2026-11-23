"use client";

import { RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatClockInZone } from "@/lib/format";

/**
 * The live region for a screen that polls (#725). When a refresh fails the screen keeps what it shows and this
 * says so, with the last good refresh and a Retry; the next good refresh empties it.
 */
export function UpdatesPaused(props: {
  paused: boolean;
  lastUpdated: Date;
  timeZone: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div role="status">
      {props.paused && (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3">
          <WifiOff className="size-5 shrink-0 text-destructive" aria-hidden />
          <p className="min-w-48 flex-1 text-sm text-foreground">
            <span className="font-semibold">Updates paused.</span>{" "}
            <span className="text-muted-foreground">
              Last updated {formatClockInZone(props.lastUpdated, props.timeZone)}. What you see may be out of date.
            </span>
          </p>
          <Button
            variant="outline"
            className="min-h-11 rounded-full px-4"
            onClick={props.onRetry}
            disabled={props.retrying}
          >
            <RefreshCw className={props.retrying ? "motion-safe:animate-spin" : undefined} aria-hidden /> Retry
          </Button>
        </div>
      )}
    </div>
  );
}
