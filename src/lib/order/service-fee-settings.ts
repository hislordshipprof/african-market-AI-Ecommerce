import { platform } from "../db";
import type { ServiceFeeSettings } from "./platform-fee";

type SettingsReader = {
  platformSettings: {
    findUniqueOrThrow(args: { where: { id: string } }): Promise<{
      serviceFeeBps: number;
      serviceFeeMinCents: number;
      serviceFeeMaxCents: number;
    }>;
  };
};

/** The rate, minimum and maximum are platform settings (one row, seeded by migration). */
export async function readServiceFeeSettings(db: SettingsReader = platform): Promise<ServiceFeeSettings> {
  const row = await db.platformSettings.findUniqueOrThrow({ where: { id: "platform" } });
  return { rateBps: row.serviceFeeBps, minCents: row.serviceFeeMinCents, maxCents: row.serviceFeeMaxCents };
}
