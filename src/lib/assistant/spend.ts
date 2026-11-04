import { claimAssistantCapDay, insertAssistantSpend, sumAssistantSpend } from "../db";

const DEFAULT_CAP_MICROS = BigInt(10_000_000);
let invalidCapLogged = false;
let spendWriteFailures = 0;

/** Test hook: the next n ledger writes throw, then recording works again. */
export function failNextSpendWrites(count: number): void {
  spendWriteFailures = count;
}

export function resetInvalidCapLog(): void {
  invalidCapLogged = false;
}

export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function spendCapMicros(
  env: { ASSISTANT_SPEND_CAP_USD?: string } = { ASSISTANT_SPEND_CAP_USD: process.env.ASSISTANT_SPEND_CAP_USD },
): { micros: bigint; invalid: boolean } {
  const raw = env.ASSISTANT_SPEND_CAP_USD;
  if (raw == null) return { micros: DEFAULT_CAP_MICROS, invalid: false };
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return { micros: BigInt(0), invalid: true };
  const [whole, frac = ""] = trimmed.split(".");
  const padded = (frac + "000000").slice(0, 6);
  return { micros: BigInt(whole) * BigInt(1_000_000) + BigInt(padded), invalid: false };
}

export async function recordSpend(micros: bigint, at: Date = new Date()): Promise<void> {
  if (spendWriteFailures > 0) {
    spendWriteFailures -= 1;
    throw new Error("spend write failed");
  }
  const day = utcDay(at);
  const amount = micros < BigInt(0) ? BigInt(0) : micros;
  await insertAssistantSpend(day, amount);
}

export async function assistantSpendState(env: { ASSISTANT_SPEND_CAP_USD?: string } = {
  ASSISTANT_SPEND_CAP_USD: process.env.ASSISTANT_SPEND_CAP_USD,
}): Promise<{
  spentMicros: bigint;
  capMicros: bigint;
  resting: boolean;
}> {
  const cap = spendCapMicros(env);
  if (cap.invalid && !invalidCapLogged) {
    invalidCapLogged = true;
    console.error("[assistant] ASSISTANT_SPEND_CAP_USD is invalid; the helper is resting");
  }
  const spentMicros = await sumAssistantSpend();
  return {
    spentMicros,
    capMicros: cap.invalid ? BigInt(0) : cap.micros,
    resting: cap.invalid || spentMicros >= cap.micros,
  };
}

export async function claimCapAlert(day: string): Promise<boolean> {
  const won = await claimAssistantCapDay(day);
  if (won) {
    const state = await assistantSpendState();
    console.error("[assistant] spend cap reached", {
      spentMicros: state.spentMicros.toString(),
      capMicros: state.capMicros.toString(),
    });
  }
  return won;
}
