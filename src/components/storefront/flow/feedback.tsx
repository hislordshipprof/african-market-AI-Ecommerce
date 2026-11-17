"use client";
import { useEffect, type ReactNode } from "react";
import {
  AnimatePresence,
  LazyMotion,
  MotionConfig,
  domAnimation,
  m,
  useReducedMotion,
  type HTMLMotionProps,
} from "motion/react";
import { Check, LockKeyhole, X } from "lucide-react";

/** The storefront shell no longer provides motion (#563), so these flow pieces bring their own. */
function MotionScope({ children }: { children: ReactNode }) {
  return <LazyMotion features={domAnimation}><MotionConfig reducedMotion="user">{children}</MotionConfig></LazyMotion>;
}

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
    <MotionScope><AnimatePresence>
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
    </AnimatePresence></MotionScope>
  );
}
/**
 * The pay button's text. Real checkout never borrows the demo walkthrough's
 * wording; the demo keeps it (#708 AC2a).
 */
export function payButtonLabel(
  state: "idle" | "pending" | "success",
  realPayment: boolean,
  idleLabel: string,
): string {
  if (state === "pending") return realPayment ? "Authorizing payment…" : "Authorizing test hold…";
  if (state === "success") return realPayment ? "Order placed" : "Demo order placed";
  return idleLabel;
}

export function PayButton({
  state,
  label,
  realPayment = true,
  disabled,
  ...props
}: {
  state: "idle" | "pending" | "success";
  label: string;
  /** Real payment by default; the demo walkthrough passes false for its own wording. */
  realPayment?: boolean;
} & HTMLMotionProps<"button">) {
  const reduced = useReducedMotion();
  return (
    <MotionScope><m.button
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
        {payButtonLabel(state, realPayment, label)}
      </span>
    </m.button></MotionScope>
  );
}

export function SuccessMark() {
  const reduced = useReducedMotion();
  return (
    <MotionScope><m.span
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
    </m.span></MotionScope>
  );
}
