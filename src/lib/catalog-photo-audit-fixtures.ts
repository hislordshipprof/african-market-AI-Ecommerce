import { platformAdminTransaction } from "./db";

type AdminTx = Parameters<Parameters<typeof platformAdminTransaction>[0]>[0];

export function photoAuditRunIds(prefix: string) {
  const named = {
    active: `${prefix}-active`,
    inactive: `${prefix}-inactive`,
    rejected: `${prefix}-rejected`,
  };
  const blocked = `${prefix}-blocked`;
  const bulkIds = Array.from({ length: 1001 }, (_, index) => `${prefix}-b${index}`);
  const cleanupIds = [named.active, named.inactive, named.rejected, blocked, ...bulkIds];
  return { named, blocked, bulkIds, cleanupIds };
}

/**
 * Three named rows, awaited on one transaction client.
 * `failAfter` throws before that insert so the transaction can roll back.
 */
export async function insertNamedPhotoAuditFixtures(
  tx: AdminTx,
  prefix: string,
  failAfter?: number,
): Promise<void> {
  const rows = [
    {
      id: `${prefix}-active`,
      name: `${prefix} active`,
      status: "active",
      imageUrl: "/api/catalog-image/catalog/active.webp",
    },
    {
      id: `${prefix}-inactive`,
      name: `${prefix} inactive`,
      status: "inactive",
      imageUrl: "/api/catalog-image/catalog/inactive.webp",
    },
    {
      id: `${prefix}-rejected`,
      name: `${prefix} rejected`,
      status: "rejected",
      imageUrl: null,
    },
  ];
  for (let index = 0; index < rows.length; index += 1) {
    if (failAfter !== undefined && index === failAfter) {
      throw new Error("injected partial failure");
    }
    const row = rows[index];
    if (!row) break;
    await tx.masterProduct.create({ data: row });
  }
}

export async function deletePhotoAuditIds(ids: string[]): Promise<void> {
  await platformAdminTransaction(async (tx) => {
    await tx.masterProduct.deleteMany({ where: { id: { in: ids } } });
  });
}

/** Deletes only this prefix's registered ids, including an attempted denied insert. */
export async function deletePhotoAuditRun(prefix: string): Promise<void> {
  await deletePhotoAuditIds(photoAuditRunIds(prefix).cleanupIds);
}
