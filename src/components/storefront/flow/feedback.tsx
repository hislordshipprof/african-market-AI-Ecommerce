"use client";
import { useEffect } from "react";
import {
  AnimatePresence,
  m,
  useReducedMotion,
  type HTMLMotionProps,
} from "motion/react";
import { Check, LockKeyhole, X } from "lucide-react";

export function FlowToast({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  const reduced = useReducedMotion();
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(onClose, 6000);
    return () => clearTimeout(timer);
  }, [message, onClose]);
  return (
    <AnimatePresence>
      {message && (
        <m.div
          className="flow-toast"
          role="status"
          initial={reduced ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduced ? 0 : 8 }}
          transition={{ duration: reduced ? 0 : 0.2 }}
        >
          <Check size={20} aria-hidden />
          <span>{message}</span>
          <button aria-label="Dismiss notification" onClick={onClose}>
            <X size={18} />
          </button>
        </m.div>
      )}
    </AnimatePresence>
  );
}
export function PayButton({
  state,
  label,
  disabled,
  ...props
}: {
  state: "idle" | "pending" | "success";
  label: string;
} & HTMLMotionProps<"button">) {
  const reduced = useReducedMotion();
  return (
    <m.button
      {...props}
      className="sf-button flow-pay"
      disabled={disabled || state !== "idle"}
      aria-busy={state === "pending"}
      whileTap={reduced ? undefined : { scale: 0.97 }}
    >
      <m.span
        className="flow-pay-fill"
        initial={false}
        animate={{ scaleX: state === "success" ? 1 : 0 }}
        transition={{ duration: reduced ? 0 : 0.45, ease: [0.45, 0, 0.05, 1] }}
      />
      <span className="flow-pay-label">
        {state === "success" ? (
          <Check size={20} aria-hidden />
        ) : (
          <LockKeyhole size={18} aria-hidden />
        )}
        {state === "pending"
          ? "Authorizing test hold…"
          : state === "success"
            ? "Demo order placed"
            : label}
      </span>
    </m.button>
  );
}

export function SuccessMark() {
  const reduced = useReducedMotion();
  return (
    <m.span
      className="flow-success-mark"
      initial={reduced ? false : { scale: 0.6 }}
      animate={{ scale: 1 }}
      transition={
        reduced
          ? { duration: 0 }
          : { type: "spring", stiffness: 300, damping: 17, mass: 0.7 }
      }
    >
      <Check size={30} aria-hidden />
    </m.span>
  );
}
