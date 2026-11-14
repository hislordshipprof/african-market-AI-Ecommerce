"use client";

import { useCallback, useSyncExternalStore } from "react";
import styles from "./assistant.module.css";

export interface AssistantSlotTarget {
  element: HTMLElement;
  label: string;
}

// The most recently mounted slot (the cart drawer over a page) gets the entry.
let slots: AssistantSlotTarget[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The launcher renders its in-page entry here; it stays empty when the helper is off. */
export function AssistantSlot({ label }: { label: string }) {
  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return;
      const target = { element, label };
      slots = [...slots, target];
      emit();
      return () => {
        slots = slots.filter((slot) => slot !== target);
        emit();
      };
    },
    [label],
  );
  return <div ref={ref} className={styles.slot} />;
}

export function useAssistantSlot(): AssistantSlotTarget | null {
  return useSyncExternalStore(
    subscribe,
    () => slots[slots.length - 1] ?? null,
    () => null,
  );
}
