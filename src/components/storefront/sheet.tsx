"use client";

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { m, useReducedMotion } from "motion/react";
import { X } from "lucide-react";
import styles from "./cart.module.css";

const subscribeMobile = (listener: () => void) => {
  const query = window.matchMedia("(max-width: 767px)");
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
};

export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const reduced = useReducedMotion();
  const mobile = useSyncExternalStore(
    subscribeMobile,
    () => window.matchMedia("(max-width: 767px)").matches,
    () => false,
  );
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
    <m.dialog
      ref={ref}
      className={styles.sheet}
      initial={false}
      animate={
        reduced
          ? { x: 0, y: 0 }
          : {
              x: !open && !mobile ? "100%" : "0%",
              y: !open && mobile ? "100%" : "0%",
            }
      }
      transition={{
        duration: reduced ? 0 : open ? 0.3 : 0.2,
        ease: open ? [0, 0, 0, 1] : [0.4, 0, 1, 1],
      }}
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
            aria-label={title === "Your cart" ? "Close cart" : `Close ${title}`}
            onClick={onClose}
          >
            <X size={22} />
          </button>
        </header>
        {children}
      </div>
    </m.dialog>
  );
}
