const DEFAULT_MINUTES = 10;

export type CancelWindow =
  | { ok: true; minutes: number }
  | { ok: false };

/** Unset means 10. An integer from 5 to 10 is used as given. Anything else fails closed. */
export function readCancelWindow(env: NodeJS.ProcessEnv = process.env): CancelWindow {
  const raw = env.ASSISTANT_CANCEL_WINDOW_MIN;
  if (raw == null || raw.trim() === "") return { ok: true, minutes: DEFAULT_MINUTES };
  if (!/^\d+$/.test(raw.trim())) return { ok: false };
  const minutes = Number(raw.trim());
  if (minutes < 5 || minutes > 10) return { ok: false };
  return { ok: true, minutes };
}
