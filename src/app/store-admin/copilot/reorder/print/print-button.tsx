"use client";

import { Button } from "@/components/ui/button";

export function PrintButton() {
  return (
    <Button type="button" className="min-h-11 rounded-full px-4 print:hidden" onClick={() => window.print()}>
      Print
    </Button>
  );
}
