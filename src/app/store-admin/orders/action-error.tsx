import { AlertCircle } from "lucide-react";
import { TwoFactorSetupLink } from "../two-factor-error";

/** A failed staff action, shown beside the order or line it was for (#725). Sonner is only for confirmations. */
export function ActionError({ message, setupHref, className = "" }: {
  message: string | null | undefined;
  /** Set when the action needs 2FA (#840). */
  setupHref?: string;
  className?: string;
}) {
  if (!message) return null;
  return (
    <p role="alert" className={`flex items-start gap-1.5 text-sm font-medium text-destructive ${className}`}>
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{message}{setupHref && <> <TwoFactorSetupLink href={setupHref} /></>}</span>
    </p>
  );
}
