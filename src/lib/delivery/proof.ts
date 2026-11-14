import { storeScoped } from "../db";
import { deleteDeliveryProof, deliveryProofBucket, deliveryProofKey, uploadDeliveryProof } from "../r2";
import { DELIVERY_PROOF_MAX_BYTES, prepareProofPhoto } from "../order/delivery-proof";

const FETCH_TIMEOUT_MS = 15_000;

export interface ProofCopyDeps {
  fetch?: typeof fetch;
  upload?: (key: string, body: Buffer) => Promise<void>;
  remove?: (key: string) => Promise<void>;
}

/**
 * Copies a courier's drop-off photo into the private proof bucket, the same store as a store driver's photo (#134),
 * so the tracking page serves it through /api/delivery-proof. Provider image links expire (Uber keeps them 30 days).
 * Throws on a network or storage error so Inngest retries; an unusable image is logged and dropped.
 */
export async function copyCourierProof(storeId: string, deliveryId: string, deps: ProofCopyDeps = {}): Promise<"copied" | "skipped"> {
  const scoped = storeScoped(storeId);
  const delivery = await scoped.delivery.findUnique({
    where: { id: deliveryId },
    select: { orderId: true, proofUrl: true, order: { select: { deliveryProofKey: true } } },
  });
  if (!delivery?.proofUrl || delivery.order.deliveryProofKey) return "skipped";
  if (!deliveryProofBucket()) {
    console.error(JSON.stringify({ event: "courier_proof_storage_missing", storeId, deliveryId }));
    return "skipped";
  }
  const res = await (deps.fetch ?? fetch)(delivery.proofUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error" });
  if (!res.ok) throw new Error(`Proof photo download failed with ${res.status}`);
  if (Number(res.headers.get("content-length") ?? 0) > DELIVERY_PROOF_MAX_BYTES) return dropped(storeId, deliveryId, "too_large");
  const prepared = await prepareProofPhoto(new Uint8Array(await res.arrayBuffer()));
  if (!prepared.ok) return dropped(storeId, deliveryId, prepared.error);

  const uploadedAt = new Date();
  const key = deliveryProofKey(delivery.orderId, uploadedAt.getTime());
  await (deps.upload ?? uploadDeliveryProof)(key, prepared.jpeg);
  const { count } = await scoped.order.updateMany({
    where: { id: delivery.orderId, deliveryProofKey: null },
    data: { deliveryProofKey: key, deliveryProofUploadedAt: uploadedAt },
  });
  if (count === 0) await (deps.remove ?? deleteDeliveryProof)(key);
  return "copied";
}

function dropped(storeId: string, deliveryId: string, reason: string): "skipped" {
  console.error(JSON.stringify({ event: "courier_proof_unusable", storeId, deliveryId, reason }));
  return "skipped";
}
