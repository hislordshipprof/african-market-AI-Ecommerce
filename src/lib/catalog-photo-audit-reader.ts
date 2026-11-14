import { disconnectPlatformClient, platform, platformSessionUser } from "./db";
import type { AuditProduct } from "./catalog-photo-audit";

const masterProductSelect = {
  id: true,
  name: true,
  status: true,
  imageUrl: true,
} as const;

/** The only delegate the audit may use. Same object the read-only checks write through. */
export function photoAuditMasterProduct() {
  return platform.masterProduct;
}

/** Scalar projection only. No relation include, nested select, filter, or count. */
export async function readMasterProductsForPhotoAudit(): Promise<AuditProduct[]> {
  const rows = await photoAuditMasterProduct().findMany({
    select: masterProductSelect,
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    imageUrl: row.imageUrl,
  }));
}

/** Login role of the client `platform.masterProduct` uses, not the role after SET LOCAL. */
export async function photoAuditLoginRole(): Promise<string> {
  return platformSessionUser();
}

export async function disconnectPhotoAudit(): Promise<void> {
  await disconnectPlatformClient();
}
