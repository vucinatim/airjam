import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";
import {
  type ReleaseStorage,
  type ReleaseStoredObjectHead,
  type ReleaseStoredObjectSummary,
} from "./release-storage";
import { getReleaseStorageConfig } from "./release-storage-config";

const METADATA_ORIGINAL_FILENAME_KEY = "original-filename";

export const normalizeReleaseDownloadFilename = (filename: string): string => {
  const leaf = filename.replaceAll("\\", "/").split("/").at(-1)?.trim();
  return !leaf || leaf === "." || leaf === ".."
    ? "air-jam-release.zip"
    : leaf.replace(/[\r\n]/g, "_");
};

export const buildReleaseAttachmentContentDisposition = (
  filename: string,
): string => {
  const asciiFilename = filename
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .replace(/[\r\n]/g, "_");
  const encodedFilename = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`;
};

const normalizeMetadata = (
  metadata: Record<string, string> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(metadata ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );

const createR2Client = (): S3Client => {
  const config = getReleaseStorageConfig();
  return new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    forcePathStyle: true,
    // R2 browser uploads work reliably with presigned PUT URLs only when the SDK
    // does not opportunistically inject checksum signing parameters.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
    },
  });
};

const streamToBuffer = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
};

const bodyToBuffer = async (body: unknown): Promise<Buffer> => {
  if (!body) {
    return Buffer.alloc(0);
  }

  if (typeof body === "object" && body !== null) {
    const bodyWithTransform = body as {
      transformToByteArray?: () => Promise<Uint8Array>;
    };

    if (typeof bodyWithTransform.transformToByteArray === "function") {
      return Buffer.from(await bodyWithTransform.transformToByteArray());
    }
  }

  if (body instanceof Readable) {
    return streamToBuffer(body);
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  if (typeof body === "string") {
    return Buffer.from(body);
  }

  throw new Error("Unsupported R2 object body type.");
};

export const assertR2DeleteObjectsSucceeded = (
  errors: readonly { Code?: string }[] | undefined,
): void => {
  if (!errors?.length) return;
  const codes = [...new Set(errors.map((error) => error.Code ?? "unknown"))];
  throw new Error(
    `R2 rejected ${errors.length} object deletions (${codes.join(", ")}).`,
  );
};

export const createR2ReleaseStorage = (): ReleaseStorage => {
  const config = getReleaseStorageConfig();
  const client = createR2Client();

  const headObject = async (
    key: string,
  ): Promise<ReleaseStoredObjectHead | null> => {
    try {
      const response = await client.send(
        new HeadObjectCommand({
          Bucket: config.bucket,
          Key: key,
        }),
      );

      return {
        key,
        sizeBytes: response.ContentLength ?? 0,
        contentType: response.ContentType ?? null,
        etag: response.ETag ?? null,
        lastModifiedAt: response.LastModified ?? null,
        metadata: normalizeMetadata(response.Metadata),
      };
    } catch (error) {
      const errorCode =
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        typeof error.name === "string"
          ? error.name
          : null;

      if (errorCode === "NotFound" || errorCode === "NoSuchKey") {
        return null;
      }

      throw error;
    }
  };

  const listObjects = async (
    prefix: string,
  ): Promise<ReleaseStoredObjectSummary[]> => {
    const objects: ReleaseStoredObjectSummary[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const item of response.Contents ?? []) {
        if (!item.Key) continue;
        objects.push({
          key: item.Key,
          sizeBytes: item.Size ?? 0,
          etag: item.ETag ?? null,
          lastModifiedAt: item.LastModified ?? null,
        });
      }
      continuationToken = response.IsTruncated
        ? response.NextContinuationToken
        : undefined;
    } while (continuationToken);
    return objects.sort((left, right) => left.key.localeCompare(right.key));
  };

  const deleteObjects = async (keys: readonly string[]): Promise<void> => {
    for (let offset = 0; offset < keys.length; offset += 1_000) {
      const batch = keys.slice(offset, offset + 1_000);
      if (batch.length === 0) continue;
      const response = await client.send(
        new DeleteObjectsCommand({
          Bucket: config.bucket,
          Delete: {
            Objects: batch.map((key) => ({ Key: key })),
            Quiet: true,
          },
        }),
      );
      assertR2DeleteObjectsSucceeded(response.Errors);
    }
  };

  return {
    async createArtifactUploadTarget({ key, contentType, originalFilename }) {
      const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ContentType: contentType,
        IfNoneMatch: "*",
        Metadata: {
          [METADATA_ORIGINAL_FILENAME_KEY]: originalFilename,
        },
      });

      const url = await getSignedUrl(client, command, {
        expiresIn: config.uploadUrlTtlSeconds,
      });

      return {
        key,
        method: "PUT",
        url,
        headers: {
          "content-type": contentType,
          "if-none-match": "*",
        },
        expiresAt: new Date(
          Date.now() + config.uploadUrlTtlSeconds * 1_000,
        ).toISOString(),
      };
    },

    async createArtifactDownloadTarget({ key, filename }) {
      const downloadFilename = normalizeReleaseDownloadFilename(filename);
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: key,
          ResponseContentDisposition:
            buildReleaseAttachmentContentDisposition(downloadFilename),
          ResponseContentType: "application/zip",
        }),
        { expiresIn: config.uploadUrlTtlSeconds },
      );

      return {
        method: "GET",
        url,
        filename: downloadFilename,
        expiresAt: new Date(
          Date.now() + config.uploadUrlTtlSeconds * 1_000,
        ).toISOString(),
      };
    },

    headObject,
    listObjects,
    deleteObjects,

    async readObject(key, options) {
      const response = await client.send(
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: key,
          IfMatch: options?.expectedEtag,
        }),
      );

      if (!response.Body) {
        throw new Error(`Release storage object has no body: ${key}`);
      }

      return bodyToBuffer(response.Body);
    },

    async putObject({ key, body, cacheControl, contentType, writeMode }) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          CacheControl: cacheControl,
          ContentType: contentType,
          IfNoneMatch: writeMode === "create" ? "*" : undefined,
        }),
      );
    },

    async deletePrefix(prefix) {
      const objects = await listObjects(prefix);
      await deleteObjects(objects.map((object) => object.key));
    },
  };
};
