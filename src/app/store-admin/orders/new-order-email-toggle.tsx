"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { setNewOrderEmailAction } from "@/lib/email/new-order-owner-actions";

/** "New-order email": an owner turns their own email for each new order on or off (#785). */
export function NewOrderEmailToggle({ initialOn }: { initialOn: boolean }) {
  const [on, setOn] = useState(initialOn);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      const result = await setNewOrderEmailAction(!on);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setOn(!on);
      toast.success(on ? "You will not get an email for new orders." : "You will get an email for each new order.");
    } catch {
      toast.error("Could not change the new-order email.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant={on ? "secondary" : "outline"}
      size="sm"
      className="min-h-11"
      onClick={toggle}
      disabled={busy}
      aria-pressed={on}
    >
      <Mail className="size-4" />
      {on ? "New-order email: on" : "New-order email: off"}
    </Button>
  );
}
