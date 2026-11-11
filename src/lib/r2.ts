import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

export type R2Credentials = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
};

/** Endpoint, region and credentials shared by uploads and the catalog audit. */
export function r2ClientConfig(credentials: R2Credentials) {
  return {
    region: "auto" as const,
    endpoint: `https://${credentials.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
  };
}

function credentialsFromEnv(): R2Credentials {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY are required");
  }
  return { accountId, accessKeyId, secretAccessKey };
}

export function getR2Client(credentials?: R2Credentials) {
  return new S3Client(r2ClientConfig(credentials ?? credentialsFromEnv()));
}

export function catalogImageUrl(key: string): string {
  const publicUrl = process.env.R2_PUBLIC_URL;
  if (publicUrl) {
    return `${publicUrl.replace(/\/+$/, "")}/${key}`;
  }
  return `/api/catalog-image/${key}`;
}

export async function uploadToR2(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string,
): Promise<string> {
  const bucket = process.env.R2_BUCKET;
  if (!bucket) throw new Error("R2_BUCKET is required");

  const client = getR2Client();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );

  return catalogImageUrl(key);
}

const ALLOWED_KEY_RE = /^catalog\/[a-zA-Z0-9_-]+\.(jpg|png|svg|webp)$/;

/** Route allowlist for `/api/catalog-image`. Dots in the object name fail. */
export function isServableCatalogKey(key: string): boolean {
  return ALLOWED_KEY_RE.test(key);
}

const DELIVERY_PROOF_KEY_RE = /^delivery-proof\/[a-z0-9]+\/\d+\.jpg$/;

/** Private proof photos, always re-encoded to JPEG. Never servable by the catalog route. */
export function deliveryProofKey(orderId: string, timestamp: number): string {
  return `delivery-proof/${orderId}/${timestamp}.jpg`;
}

export function isDeliveryProofKey(key: string): boolean {
  return DELIVERY_PROOF_KEY_RE.test(key);
}

/** Proofs live only in their own private bucket, never the catalog one (ADR 0013). */
export function deliveryProofBucket(): string | null {
  return process.env.R2_PROOF_BUCKET?.trim() || null;
}

export async function uploadDeliveryProof(key: string, body: Buffer | Uint8Array): Promise<void> {
  const bucket = deliveryProofBucket();
  if (!bucket) throw new Error("R2_PROOF_BUCKET is required");
  if (!isDeliveryProofKey(key)) throw new Error("not a delivery-proof key");
  await getR2Client().send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "image/jpeg" }),
  );
}

const ISSUE_PHOTO_KEY_RE = /^issue-photo\/[a-z0-9]+\/[a-z0-9]+\.jpg$/;

/** A customer's issue photo (#428): private, in the proof bucket, never servable by the catalog route. */
export function issuePhotoKey(orderId: string, issueId: string): string {
  return `issue-photo/${orderId}/${issueId}.jpg`;
}

export function isIssuePhotoKey(key: string): boolean {
  return ISSUE_PHOTO_KEY_RE.test(key);
}

export async function uploadIssuePhoto(key: string, body: Buffer | Uint8Array): Promise<void> {
  const bucket = deliveryProofBucket();
  if (!bucket) throw new Error("R2_PROOF_BUCKET is required");
  if (!isIssuePhotoKey(key)) throw new Error("not an issue-photo key");
  await getR2Client().send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "image/jpeg" }),
  );
}

const OWNER_REPORT_PHOTO_KEY_RE = /^owner-reports\/[a-z0-9-]+\/[a-z0-9]+\.jpg$/;

/** A store member's invoice or shelf photo (#21): private, in the proof bucket, never servable by the catalog route. */
export function ownerReportPhotoKey(storeId: string, reportId: string): string {
  return `owner-reports/${storeId}/${reportId}.jpg`;
}

export function isOwnerReportPhotoKey(key: string): boolean {
  return OWNER_REPORT_PHOTO_KEY_RE.test(key);
}

export async function uploadOwnerReportPhoto(key: string, body: Buffer | Uint8Array): Promise<void> {
  const bucket = deliveryProofBucket();
  if (!bucket) throw new Error("R2_PROOF_BUCKET is required");
  if (!isOwnerReportPhotoKey(key)) throw new Error("not an owner-report key");
  await getR2Client().send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "image/jpeg" }),
  );
}

export async function streamFromR2(
  key: string,
): Promise<{ body: ReadableStream; contentType: string } | null> {
  if (!isServableCatalogKey(key)) return null;
  const bucket = process.env.R2_BUCKET;
  if (!bucket) return null;
  return getObject(bucket, key);
}

/** Read through the private delivery-proof route only. */
export async function streamDeliveryProof(
  key: string,
): Promise<{ body: ReadableStream; contentType: string } | null> {
  const bucket = deliveryProofBucket();
  if (!bucket || !isDeliveryProofKey(key)) return null;
  return getObject(bucket, key);
}

/** Read through the store-member issue-photo route only. */
export async function streamIssuePhoto(
  key: string,
): Promise<{ body: ReadableStream; contentType: string } | null> {
  const bucket = deliveryProofBucket();
  if (!bucket || !isIssuePhotoKey(key)) return null;
  return getObject(bucket, key);
}

async function getObject(
  bucket: string,
  key: string,
): Promise<{ body: ReadableStream; contentType: string } | null> {
  try {
    const client = getR2Client();
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!response.Body) return null;
    const webStream = response.Body.transformToWebStream();
    return {
      body: webStream as ReadableStream,
      contentType: response.ContentType ?? "application/octet-stream",
    };
  } catch {
    return null;
  }
}
