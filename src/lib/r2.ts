import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

function getR2Client() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY are required");
  }
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
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

export async function streamFromR2(
  key: string,
): Promise<{ body: ReadableStream; contentType: string } | null> {
  if (!ALLOWED_KEY_RE.test(key)) return null;

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
