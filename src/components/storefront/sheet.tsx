"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import styles from "./cart.module.css";

export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  side = "end",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** A fixed footer below the independently scrolling body (e.g. the cart summary, #708 AC1). */
  footer?: ReactNode;
  /** "start" opens from the left on desktop (the aisle drawer, #862); both sides rise from the bottom on phones. */
  side?: "start" | "end";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const restore = useRef<(() => void) | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    if (dialog.open) {
      delete dialog.dataset.closing;
      return;
    }
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const overflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = "hidden";
    restore.current = () => {
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
      else document.getElementById("storefront-search")?.focus();
      restore.current = null;
    };
  }, [open]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || open || !dialog.open) return;
    dialog.dataset.closing = "true";
    const timeout = window.setTimeout(
      () => {
        dialog.close();
        delete dialog.dataset.closing;
        restore.current?.();
      },
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 200,
    );
    return () => window.clearTimeout(timeout);
  }, [open]);
  useEffect(() => {
    const dialog = ref.current;
    return () => {
      dialog?.close();
      restore.current?.();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={side === "start" ? `${styles.sheet} ${styles.sheetStart}` : styles.sheet}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={styles.sheetInner}>
        <header className={styles.sheetHeader}>
          <h2>{title}</h2>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={title === "Your basket" ? "Close basket" : `Close ${title}`}
            onClick={onClose}
          >
            <X size={22} />
          </button>
        </header>
        <div className={styles.sheetBody}>{children}</div>
        {footer && <div className={styles.sheetFooter}>{footer}</div>}
      </div>
    </dialog>
  );
}
