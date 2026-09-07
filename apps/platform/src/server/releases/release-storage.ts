import { createR2ReleaseStorage } from "./release-storage-r2";

export type ReleaseArtifactUploadTarget = {
  key: string;
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
};

export type ReleaseArtifactDownloadTarget = {
  method: "GET";
  url: string;
  expiresAt: string;
  filename: string;
};

export type ReleaseStoredObjectHead = {
  key: string;
  sizeBytes: number;
  contentType: string | null;
  etag: string | null;
  lastModifiedAt: Date | null;
  metadata: Record<string, string>;
};

export type ReleaseStoredObjectSummary = {
  key: string;
  sizeBytes: number;
  etag: string | null;
  lastModifiedAt: Date | null;
};

export type CreateReleaseArtifactUploadTargetInput = {
  key: string;
  contentType: string;
  originalFilename: string;
};

export type CreateReleaseArtifactDownloadTargetInput = {
  key: string;
  filename: string;
};

export type PutReleaseObjectInput = {
  key: string;
  body: Buffer;
  contentType: string;
  cacheControl?: string;
  writeMode: "create";
};

export interface ReleaseStorage {
  createArtifactUploadTarget(
    input: CreateReleaseArtifactUploadTargetInput,
  ): Promise<ReleaseArtifactUploadTarget>;
  createArtifactDownloadTarget(
    input: CreateReleaseArtifactDownloadTargetInput,
  ): Promise<ReleaseArtifactDownloadTarget>;
  headObject(key: string): Promise<ReleaseStoredObjectHead | null>;
  readObject(key: string, options?: { expectedEtag?: string }): Promise<Buffer>;
  putObject(input: PutReleaseObjectInput): Promise<void>;
  listObjects(prefix: string): Promise<ReleaseStoredObjectSummary[]>;
  deleteObjects(keys: readonly string[]): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

let releaseStorageSingleton: ReleaseStorage | null = null;

export const getReleaseStorage = (): ReleaseStorage => {
  if (!releaseStorageSingleton) {
    releaseStorageSingleton = createR2ReleaseStorage();
  }

  return releaseStorageSingleton;
};
