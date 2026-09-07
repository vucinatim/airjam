import { describe, expect, it } from "vitest";
import {
  assertR2DeleteObjectsSucceeded,
  buildReleaseAttachmentContentDisposition,
  normalizeReleaseDownloadFilename,
} from "./release-storage-r2";

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
