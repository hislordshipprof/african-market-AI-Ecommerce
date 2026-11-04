import { HeadBucketCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { r2ClientConfig, type R2Credentials } from "./r2";
import { CatalogAuditError, statusLabel, type HeadResult } from "./catalog-photo-audit";

/** Default socket and request deadline. SDK default is 0 (no timeout). */
export const CATALOG_HEAD_TIMEOUT_MS = 10_000;

export type R2HeadConfig = R2Credentials & {
  bucket: string;
  requestTimeoutMs?: number;
};

export function resolveHeadTimeout(requestTimeoutMs: number | undefined): number {
  const timeoutMs = requestTimeoutMs ?? CATALOG_HEAD_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > CATALOG_HEAD_TIMEOUT_MS) {
    throw new CatalogAuditError("requestTimeoutMs must be a finite number from 1 to 10000", {
      statusLabel: "timeout",
    });
  }
  return timeoutMs;
}

/**
 * Production client config. Endpoint is always the account's R2 S3 API.
 * `maxAttempts` is left unset so the SDK's own retry policy applies once.
 */
export function catalogHeadClientConfig(config: R2HeadConfig) {
  const timeoutMs = resolveHeadTimeout(config.requestTimeoutMs);
  return {
    ...r2ClientConfig(config),
    requestHandler: new NodeHttpHandler({
      connectionTimeout: timeoutMs,
      requestTimeout: timeoutMs,
      throwOnRequestTimeout: true,
    }),
  };
}

type HeadResponse = { $metadata?: { httpStatusCode?: number } };

function httpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object" || !("$metadata" in err)) return undefined;
  const metadata = (err as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
  return typeof metadata?.httpStatusCode === "number" ? metadata.httpStatusCode : undefined;
}

async function sendForStatus(
  client: S3Client,
  command: HeadBucketCommand | HeadObjectCommand,
  what: "HeadBucket" | "HeadObject",
  name: string,
): Promise<number> {
  // NodeHttpHandler's requestTimeout is the deadline. The SDK default is 0,
  // which would leave a stalled socket open, so every client is built with one.
  try {
    const response = (await client.send(command as unknown as HeadBucketCommand)) as HeadResponse;
    const status = response?.$metadata?.httpStatusCode;
    if (typeof status !== "number") {
      throw new CatalogAuditError(`${what} failed for ${name}: no status`, {
        key: what === "HeadObject" ? name : undefined,
        bucket: what === "HeadBucket" ? name : undefined,
        statusLabel: "no status",
      });
    }
    return status;
  } catch (err) {
    if (err instanceof CatalogAuditError) throw err;
    const status = httpStatus(err);
    if (typeof status === "number") return status;
    const label = statusLabel(err);
    throw new CatalogAuditError(`${what} failed for ${name}: ${label}`, {
      key: what === "HeadObject" ? name : undefined,
      bucket: what === "HeadBucket" ? name : undefined,
      statusLabel: label,
    });
  }
}

export type R2HeadApi = {
  bucket: string;
  headBucket: () => Promise<void>;
  headObject: (key: string) => Promise<HeadResult>;
  close: () => void;
};

export function createR2HeadObject(config: R2HeadConfig, deps?: { client?: S3Client }): R2HeadApi {
  const timeoutMs = resolveHeadTimeout(config.requestTimeoutMs);
  const client = deps?.client ?? new S3Client(catalogHeadClientConfig({ ...config, requestTimeoutMs: timeoutMs }));
  return {
    bucket: config.bucket,
    async headBucket() {
      const status = await sendForStatus(
        client,
        new HeadBucketCommand({ Bucket: config.bucket }),
        "HeadBucket",
        config.bucket,
      );
      if (status !== 200) {
        throw new CatalogAuditError(`HeadBucket failed for ${config.bucket}: HTTP ${status}`, {
          bucket: config.bucket,
          statusLabel: `HTTP ${status}`,
        });
      }
    },
    async headObject(key: string) {
      const status = await sendForStatus(
        client,
        new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
        "HeadObject",
        key,
      );
      if (status === 200) return "present";
      if (status === 404) return "missing";
      throw new CatalogAuditError(`HeadObject failed for ${key}: HTTP ${status}`, {
        key,
        statusLabel: `HTTP ${status}`,
      });
    },
    close() {
      client.destroy();
    },
  };
}
