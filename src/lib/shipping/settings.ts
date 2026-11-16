import { platform } from "../db";
import { fakeShippo } from "./shippo-fake";
import { ShippoProvider } from "./shippo";
import type { ShippingProvider } from "./provider";

type SettingsReader = { platformSettings: { findUnique: typeof platform.platformSettings.findUnique } };

/** States a shipped order may go to; each is added only after the tax advisor signs off (ADR-0008, ADR-0023). */
export async function readShippingStates(db: SettingsReader = platform): Promise<string[]> {
  const row = await db.platformSettings.findUnique({ where: { id: "platform" }, select: { shippingStates: true } });
  return row?.shippingStates ?? [];
}

const FAKE_TOKEN = "shippo_test_fake";

/** Shippo with SHIPPO_API_KEY; the fake outside production when E2E_FAKE_SHIPPO=1; otherwise none. */
export function shippingProvider(): ShippingProvider | null {
  if (process.env.SHIPPO_API_KEY) return new ShippoProvider();
  const fakeAllowed = !process.env.VERCEL && process.env.E2E_FAKE_SHIPPO === "1" && (process.env.CI === "true" || process.env.NODE_ENV !== "production");
  return fakeAllowed ? new ShippoProvider({ apiKey: FAKE_TOKEN, fetch: fakeShippo({ token: FAKE_TOKEN }) }) : null;
}
