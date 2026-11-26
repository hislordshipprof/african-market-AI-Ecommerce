"use client";

import { useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Sheet } from "./sheet";

/** The aisle page's phone Filter button (#862): the rail's refine filters in a sheet. */
export function FilterSheet({ active, children }: { active: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="sf-filter-button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <SlidersHorizontal size={20} aria-hidden />
        Filter
        {active && <span className="sf-filter-dot" aria-label="(filters on)" />}
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Filter">
        {open && <div className="sf-refine">{children}</div>}
      </Sheet>
    </>
  );
}
