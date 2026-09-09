import { afterEach, describe, expect, it } from "vitest";
import { resetReleaseStorageConfigForTests } from "./release-storage-config";
import {
  assertR2DeleteObjectsSucceeded,
  buildReleaseAttachmentContentDisposition,
  createR2ReleaseStorage,
  normalizeReleaseDownloadFilename,
} from "./release-storage-r2";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  resetReleaseStorageConfigForTests();
});

describe("R2 release storage uploads", () => {
  it("requires filename metadata as an explicit signed header", async () => {
    process.env.AIRJAM_RELEASES_R2_BUCKET = "release-bucket";
    process.env.AIRJAM_RELEASES_R2_ACCOUNT_ID = "example-account";
    process.env.AIRJAM_RELEASES_R2_ACCESS_KEY_ID = "test-access-key";
    process.env.AIRJAM_RELEASES_R2_SECRET_ACCESS_KEY = "test-secret-key";
    resetReleaseStorageConfigForTests();

    const target = await createR2ReleaseStorage().createArtifactUploadTarget({
      key: "games/game/releases/release/source/artifact.zip",
      contentType: "application/zip",
      originalFilename: "signal-relay.zip",
    });
    const url = new URL(target.url);

    expect(target.headers).toMatchObject({
      "content-type": "application/zip",
      "if-none-match": "*",
      "x-amz-meta-original-filename": "signal-relay.zip",
    });
    expect(url.searchParams.has("x-amz-meta-original-filename")).toBe(false);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain(
      "x-amz-meta-original-filename",
    );
  });
});

describe("R2 release storage downloads", () => {
  it("reduces caller-provided names to a safe leaf filename", () => {
    expect(normalizeReleaseDownloadFilename("../exports/game.zip")).toBe(
      "game.zip",
    );
    expect(normalizeReleaseDownloadFilename("..\\exports\\game.zip")).toBe(
      "game.zip",
    );
    expect(normalizeReleaseDownloadFilename("..")).toBe("air-jam-release.zip");
  });

  it("builds a safe attachment header for Unicode and control characters", () => {
    const disposition = buildReleaseAttachmentContentDisposition(
      'M\u00e4rio "Kart"\r\nInjected.zip',
    );

    expect(disposition).toBe(
      "attachment; filename=\"Ma_rio _Kart___Injected.zip\"; filename*=UTF-8''M%C3%A4rio%20%22Kart%22%0D%0AInjected.zip",
    );
    expect(disposition).not.toContain("\r");
    expect(disposition).not.toContain("\n");
  });
});

describe("R2 release storage deletion", () => {
  it("accepts a complete bulk-delete response", () => {
    expect(() => assertR2DeleteObjectsSucceeded(undefined)).not.toThrow();
    expect(() => assertR2DeleteObjectsSucceeded([])).not.toThrow();
  });

  it("fails closed on per-object errors without exposing object keys", () => {
    const secretKey = "games/private/resource/source.zip";
    const errors = [
      { Code: "AccessDenied", Key: secretKey },
      { Code: "AccessDenied" },
    ];
    const operation = () => assertR2DeleteObjectsSucceeded(errors);

    expect(operation).toThrow("R2 rejected 2 object deletions (AccessDenied).");
    try {
      operation();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(secretKey);
    }
  });
});
