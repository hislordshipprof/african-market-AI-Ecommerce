"use client";

import { useSyncExternalStore } from "react";
import { openStatus } from "@/lib/directory/open-status";
import styles from "./directory.module.css";

const MINUTE_MS = 60_000;

function subscribe(onChange: () => void) {
  const id = setInterval(onChange, MINUTE_MS / 2);
  return () => clearInterval(id);
}

const currentMinute = () => Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;

/**
 * Open now or opens at, worked out in the browser from public hours (#453), so a cached
 * state or city page never shows a stale answer. Empty on the server and refreshed each minute.
 */
export function OpenNow({ hours, timezone }: { hours: unknown; timezone: string }) {
  const minute = useSyncExternalStore(subscribe, currentMinute, () => null);
  if (minute === null) return <span className={styles.open} />;
  const status = openStatus(hours, timezone, new Date(minute), Intl.DateTimeFormat().resolvedOptions().timeZone);
  return (
    <span className={styles.open} data-open={status.open}>
      <span className={styles.openMark} aria-hidden="true" />
      <span className={styles.openLabel}>{status.label}</span>
      {status.detail ? <span className={styles.openDetail}>{status.detail}</span> : null}
    </span>
  );
}
