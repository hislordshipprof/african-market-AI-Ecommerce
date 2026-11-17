"use client";

import { useCallback, useSyncExternalStore } from "react";
import styles from "./assistant.module.css";

export interface AssistantSlotTarget {
  element: HTMLElement;
  label: string;
}

const PHONE = "(max-width: 767px)";

// The most recently mounted slot (the cart drawer over a page) gets the entry.
let slots: AssistantSlotTarget[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * The launcher renders its in-page entry here; it stays empty when the helper is off.
 * `phoneOnly` slots take the entry only on phones and below every page slot, so on a
 * phone the entry sits in the page flow instead of floating over cards (#717 AC5).
 */
export function AssistantSlot({ label, phoneOnly = false }: { label: string; phoneOnly?: boolean }) {
  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return;
      const target = { element, label };
      const query = phoneOnly ? window.matchMedia(PHONE) : null;
      const sync = () => {
        const wanted = !query || query.matches;
        const held = slots.includes(target);
        if (wanted && !held) slots = phoneOnly ? [target, ...slots] : [...slots, target];
        else if (!wanted && held) slots = slots.filter((slot) => slot !== target);
        else return;
        emit();
      };
      sync();
      query?.addEventListener("change", sync);
      return () => {
        query?.removeEventListener("change", sync);
        slots = slots.filter((slot) => slot !== target);
        emit();
      };
    },
    [label, phoneOnly],
  );
  return <div ref={ref} className={phoneOnly ? `${styles.slot} ${styles.phoneSlot}` : styles.slot} />;
}

export function useAssistantSlot(): AssistantSlotTarget | null {
  return useSyncExternalStore(
    subscribe,
    () => slots[slots.length - 1] ?? null,
    () => null,
  );
}
