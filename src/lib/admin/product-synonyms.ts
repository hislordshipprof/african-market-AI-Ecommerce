"use server";

import {
  lockMasterProductRow,
  platformAdminTransaction,
  productsNamedByTerm,
  sameProductSynonymIds,
  storesListingMasterProduct,
} from "../db";
import { parseInput } from "../security/parse-input";
import { revalidateStorefront } from "../storefront/cache";
import { requirePlatformAdmin } from "./session";
import { z } from "zod";
import { readSynonymForm, synonymFormSchema, type SynonymField, type SynonymForm } from "./catalog-structure-form";
import { MERGED_PRODUCT_MESSAGE } from "./master-catalog-form";

export type SynonymState = {
  ok?: boolean;
  message?: string;
  fieldErrors?: Partial<Record<SynonymField, string>>;
  /** Other products the saved term also names. A shared term (agushi) is valid, so this warns, never refuses. */
  alsoNames?: string[];
};

type Session = Awaited<ReturnType<typeof requirePlatformAdmin>>;
type Result = SynonymState & { storeIds?: string[] };

const DUPLICATE = "This product already has this term";

function parseSynonym(form: FormData): { ok: true; data: SynonymForm } | { ok: false; state: SynonymState } {
  const parsed = synonymFormSchema.safeParse(readSynonymForm(form));
  if (parsed.success) return { ok: true, data: parsed.data };
  const fieldErrors: SynonymState["fieldErrors"] = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (field === "term" || field === "language" || field === "region") fieldErrors[field] ??= issue.message;
    else return { ok: false, state: { ok: false, message: "Product not found" } };
  }
  return { ok: false, state: { ok: false, message: "Check the highlighted fields", fieldErrors } };
}

function savedState(alsoNames: string[]): SynonymState {
  if (alsoNames.length === 0) return { ok: true, message: "Saved", alsoNames };
  return { ok: true, message: `Saved. This term also names ${alsoNames.join(", ")}.`, alsoNames };
}

async function audit(
  tx: Parameters<Parameters<typeof platformAdminTransaction>[0]>[0],
  session: Session,
  action: string,
  productId: string,
  before: Record<string, string | null> | null,
  after: Record<string, string | null> | null,
) {
  await tx.auditLog.create({
    data: {
      actorId: session.user.id,
      actorEmail: session.user.email,
      action,
      entityType: "master_product",
      entityId: productId,
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    },
  });
}

function finish(result: Result): SynonymState {
  const { storeIds, ...state } = result;
  for (const storeId of storeIds ?? []) revalidateStorefront(storeId);
  return state;
}

/** Adds a synonym to a master product. The product's row lock serializes the duplicate check. */
export async function addProductSynonym(_prev: SynonymState, form: FormData): Promise<SynonymState> {
  const session = await requirePlatformAdmin();
  const parsed = parseSynonym(form);
  if (!parsed.ok) return parsed.state;
  const { productId, term, language, region } = parsed.data;

  return finish(await platformAdminTransaction(async (tx): Promise<Result> => {
    await lockMasterProductRow(tx, productId);
    const product = await tx.masterProduct.findUnique({ where: { id: productId }, select: { status: true } });
    if (!product) return { ok: false, message: "Product not found" };
    if (product.status === "merged") return { ok: false, message: MERGED_PRODUCT_MESSAGE };
    if ((await sameProductSynonymIds(tx, productId, term, null)).length > 0) {
      return { ok: false, message: "Check the highlighted fields", fieldErrors: { term: DUPLICATE } };
    }
    const created = await tx.productSynonym.create({ data: { productId, term, language, region } });
    await audit(tx, session, "catalog.synonym_add", productId, null, { synonymId: created.id, term, language, region });
    return { ...savedState(await productsNamedByTerm(tx, term, productId)), storeIds: await storesListingMasterProduct(tx, productId) };
  }));
}

/** Changes a synonym's term, language or region. The synonym must belong to the product named in the form. */
export async function updateProductSynonym(_prev: SynonymState, form: FormData): Promise<SynonymState> {
  const session = await requirePlatformAdmin();
  const parsed = parseSynonym(form);
  if (!parsed.ok) return parsed.state;
  const { productId, synonymId, term, language, region } = parsed.data;
  if (!synonymId) return { ok: false, message: "Synonym not found" };

  return finish(await platformAdminTransaction(async (tx): Promise<Result> => {
    await lockMasterProductRow(tx, productId);
    const synonym = await tx.productSynonym.findUnique({ where: { id: synonymId } });
    if (!synonym || synonym.productId !== productId) return { ok: false, message: "Synonym not found" };
    if ((await sameProductSynonymIds(tx, productId, term, synonymId)).length > 0) {
      return { ok: false, message: "Check the highlighted fields", fieldErrors: { term: DUPLICATE } };
    }
    const alsoNames = await productsNamedByTerm(tx, term, productId);
    if (synonym.term === term && synonym.language === language && synonym.region === region) {
      return { ...savedState(alsoNames), message: "No changes to save" };
    }
    await tx.productSynonym.update({ where: { id: synonymId }, data: { term, language, region } });
    await audit(
      tx, session, "catalog.synonym_edit", productId,
      { synonymId, term: synonym.term, language: synonym.language, region: synonym.region },
      { synonymId, term, language, region },
    );
    return { ...savedState(alsoNames), storeIds: await storesListingMasterProduct(tx, productId) };
  }));
}

const removeSchema = z.strictObject({ productId: z.string().min(1).max(200), synonymId: z.string().min(1).max(200) });

/** Removes a synonym. The synonym must belong to the product named in the form. */
export async function removeProductSynonym(_prev: SynonymState, form: FormData): Promise<SynonymState> {
  const session = await requirePlatformAdmin();
  const parsed = parseInput(removeSchema, { productId: form.get("productId"), synonymId: form.get("synonymId") });
  if (!parsed.ok) return { ok: false, message: "Synonym not found" };
  const { productId, synonymId } = parsed.data;

  return finish(await platformAdminTransaction(async (tx): Promise<Result> => {
    await lockMasterProductRow(tx, productId);
    const synonym = await tx.productSynonym.findUnique({ where: { id: synonymId } });
    if (!synonym || synonym.productId !== productId) return { ok: false, message: "Synonym not found" };
    await tx.productSynonym.delete({ where: { id: synonymId } });
    await audit(tx, session, "catalog.synonym_remove", productId,
      { synonymId, term: synonym.term, language: synonym.language, region: synonym.region }, null);
    return { ok: true, message: "Removed", storeIds: await storesListingMasterProduct(tx, productId) };
  }));
}
