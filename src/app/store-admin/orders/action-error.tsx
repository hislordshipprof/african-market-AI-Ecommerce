import { AlertCircle } from "lucide-react";

/** A failed staff action, shown beside the order or line it was for (#725). Sonner is only for confirmations. */
export function ActionError({ message, className = "" }: { message: string | null | undefined; className?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className={`flex items-start gap-1.5 text-sm font-medium text-destructive ${className}`}>
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{message}</span>
    </p>
  );
}
