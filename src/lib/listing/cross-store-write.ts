import { platformAdmin, storeScoped } from "../db";

/**
 * Proves a store-B session cannot write store A's audit or import rows.
 * #203 reuses this probe's shape for listings, listing_variants and stock_events.
 */
export async function probeCrossStoreImportWrites(args: {
  storeAId: string;
  storeBId: string;
  actorId: string;
  actorEmail: string;
  listingImportId: string;
  expectedStatus: string;
  expectedCsvText: string;
}): Promise<{
  auditCreateRejected: boolean;
  importCreateRejected: boolean;
  updateCount: number;
  deleteCount: number;
  rowUnchanged: boolean;
}> {
  const scopedB = storeScoped(args.storeBId);

  let auditCreateRejected = false;
  try {
    await scopedB.auditLog.create({
      data: {
        storeId: args.storeAId,
        actorId: args.actorId,
        actorEmail: args.actorEmail,
        action: "catalog.csv_import",
        entityType: "listing",
        entityId: args.listingImportId,
      },
    });
  } catch (error) {
    if (!isRlsRejection(error)) throw error;
    auditCreateRejected = true;
  }

  let importCreateRejected = false;
  try {
    await scopedB.listingImport.create({
      data: {
        storeId: args.storeAId,
        csvText: "name,price\nCross Store,1.00\n",
        rowCount: 1,
        status: "pending",
        createdById: args.actorId,
      },
    });
  } catch (error) {
    if (!isRlsRejection(error)) throw error;
    importCreateRejected = true;
  }

  const updated = await scopedB.listingImport.updateMany({
    where: { id: args.listingImportId },
    data: { status: "committed" },
  });
  const deleted = await scopedB.listingImport.deleteMany({
    where: { id: args.listingImportId },
  });

  const row = await platformAdmin.listingImport.findUnique({
    where: { id: args.listingImportId },
  });

  return {
    auditCreateRejected,
    importCreateRejected,
    updateCount: updated.count,
    deleteCount: deleted.count,
    rowUnchanged:
      row?.status === args.expectedStatus && row.csvText === args.expectedCsvText,
  };
}

export function isRlsRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /row-level security|42501/i.test(message);
}
