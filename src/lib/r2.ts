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

const DELIVERY_PROOF_KEY_RE = /^delivery-proof\/[a-z0-9]+\/\d+\.(jpg|png|webp)$/;

/** Private proof photos. Never servable by the catalog route: different prefix, different reader. */
export function deliveryProofKey(orderId: string, timestamp: number, ext: "jpg" | "png" | "webp"): string {
  return `delivery-proof/${orderId}/${timestamp}.${ext}`;
}

export function isDeliveryProofKey(key: string): boolean {
  return DELIVERY_PROOF_KEY_RE.test(key);
}

export async function streamFromR2(
  key: string,
): Promise<{ body: ReadableStream; contentType: string } | null> {
  if (!isServableCatalogKey(key)) return null;
  return getObject(key);
}

/** Read through the private delivery-proof route only. */
export async function streamDeliveryProof(
  key: string,
): Promise<{ body: ReadableStream; contentType: string } | null> {
  if (!isDeliveryProofKey(key)) return null;
  return getObject(key);
}

async function getObject(
  key: string,
): Promise<{ body: ReadableStream; contentType: string } | null> {
  const bucket = process.env.R2_BUCKET;
  if (!bucket) return null;

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
