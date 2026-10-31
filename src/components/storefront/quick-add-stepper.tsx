"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Plus, Minus } from "lucide-react";

export function QuickAddStepper({ productName }: { productName: string }) {
  const [qty, setQty] = useState(0);

  return (
    <AnimatePresence mode="wait" initial={false}>
      {qty === 0 ? (
        <motion.button
          key="add"
          type="button"
          data-testid="quick-add-btn"
          onClick={() => setQty(1)}
          exit={{ scale: 0.8, opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-primary text-on-primary shadow-sm transition-transform duration-150 hover:scale-110 active:scale-95"
          aria-label={`Add ${productName} to cart`}
        >
          <Plus className="h-5 w-5" />
        </motion.button>
      ) : (
        <motion.div
          key="stepper"
          data-testid="quick-add-stepper"
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 400, damping: 25 }}
          className="flex h-11 items-center gap-1 rounded-full bg-primary px-1 shadow-sm"
        >
          <button
            type="button"
            data-testid="stepper-minus"
            onClick={() => setQty((q) => Math.max(0, q - 1))}
            className="flex h-9 w-9 items-center justify-center rounded-full text-on-primary transition-colors hover:bg-white/20"
            aria-label={`Remove one ${productName}`}
          >
            <Minus className="h-4 w-4" />
          </button>
          <span
            data-testid="stepper-qty"
            className="min-w-[1.5rem] text-center font-label text-sm font-semibold text-on-primary"
          >
            {qty}
          </span>
          <button
            type="button"
            data-testid="stepper-plus"
            onClick={() => setQty((q) => q + 1)}
            className="flex h-9 w-9 items-center justify-center rounded-full text-on-primary transition-colors hover:bg-white/20"
            aria-label={`Add another ${productName}`}
          >
            <Plus className="h-4 w-4" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
