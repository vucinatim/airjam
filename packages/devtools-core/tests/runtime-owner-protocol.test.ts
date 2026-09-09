import { describe, expect, it } from "vitest";
import {
  AIR_JAM_RUNTIME_OWNER_CAPTURE_RESULT,
  isRuntimeOwnerCaptureResult,
  resolveProjectRelativeRuntimeCaptureDir,
} from "../src/runtime-owner-protocol.js";

describe("runtime owner visual capture paths", () => {
  it("keeps capture artifacts inside the owning project", () => {
    expect(
      resolveProjectRelativeRuntimeCaptureDir({
        projectDir: "/tmp/game",
        relativeDir: ".airjam/artifacts/session-visuals/capture-1",
      }),
    ).toBe("/tmp/game/.airjam/artifacts/session-visuals/capture-1");

    expect(() =>
      resolveProjectRelativeRuntimeCaptureDir({
        projectDir: "/tmp/game",
        relativeDir: "../../private-repo",
      }),
    ).toThrow("must stay in the project");
    expect(() =>
      resolveProjectRelativeRuntimeCaptureDir({
        projectDir: "/tmp/game",
        relativeDir: "/tmp/outside",
      }),
    ).toThrow("must be project-relative");
  });
});

describe("runtime owner visual capture messages", () => {
  it("accepts complete screenshot metadata and rejects malformed IPC data", () => {
    const result = {
      type: AIR_JAM_RUNTIME_OWNER_CAPTURE_RESULT,
      requestId: "request-1",
      ok: true,
      capturedAt: "2026-09-09T00:00:00.000Z",
      screenshots: [
        {
          surface: "host",
          width: 1440,
          height: 900,
          relativePath: ".airjam/artifacts/session-visuals/host.png",
        },
      ],
      error: null,
    };

    expect(isRuntimeOwnerCaptureResult(result)).toBe(true);
    expect(
      isRuntimeOwnerCaptureResult({
        ...result,
        screenshots: [{ ...result.screenshots[0], width: 0 }],
      }),
    ).toBe(false);
  });
});
