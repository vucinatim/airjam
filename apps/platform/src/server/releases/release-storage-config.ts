import { loadReleaseStorageEnv } from "./release-env";

type ReleaseStorageConfig = {
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  uploadUrlTtlSeconds: number;
};

let cachedConfig: ReleaseStorageConfig | null = null;

export const getReleaseStorageConfig = (): ReleaseStorageConfig => {
  if (cachedConfig) {
    return cachedConfig;
  }
  cachedConfig = loadReleaseStorageEnv();

  return cachedConfig;
};

export const resetReleaseStorageConfigForTests = (): void => {
  cachedConfig = null;
};

export type { ReleaseStorageConfig };
