import path from "node:path";

export const AIR_JAM_RUNTIME_OWNER_CAPTURE_REQUEST =
  "air-jam-runtime-owner.capture-visuals/v1" as const;
export const AIR_JAM_RUNTIME_OWNER_CAPTURE_RESULT =
  "air-jam-runtime-owner.capture-visuals-result/v1" as const;

export type AirJamRuntimeOwnerCaptureRequest = {
  type: typeof AIR_JAM_RUNTIME_OWNER_CAPTURE_REQUEST;
  requestId: string;
  relativeDir: string;
};

export type AirJamRuntimeOwnerScreenshot = {
  surface: "host" | "controller";
  width: number;
  height: number;
  relativePath: string;
};

export type AirJamRuntimeOwnerCaptureResult = {
  type: typeof AIR_JAM_RUNTIME_OWNER_CAPTURE_RESULT;
  requestId: string;
  ok: boolean;
  capturedAt: string;
  screenshots: AirJamRuntimeOwnerScreenshot[];
  error: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRuntimeOwnerScreenshot = (
  value: unknown,
): value is AirJamRuntimeOwnerScreenshot =>
  isRecord(value) &&
  (value.surface === "host" || value.surface === "controller") &&
  typeof value.width === "number" &&
  Number.isInteger(value.width) &&
  value.width > 0 &&
  typeof value.height === "number" &&
  Number.isInteger(value.height) &&
  value.height > 0 &&
  typeof value.relativePath === "string" &&
  value.relativePath.length > 0;

export const isRuntimeOwnerCaptureRequest = (
  value: unknown,
): value is AirJamRuntimeOwnerCaptureRequest =>
  isRecord(value) &&
  value.type === AIR_JAM_RUNTIME_OWNER_CAPTURE_REQUEST &&
  typeof value.requestId === "string" &&
  value.requestId.length > 0 &&
  typeof value.relativeDir === "string" &&
  value.relativeDir.length > 0;

export const isRuntimeOwnerCaptureResult = (
  value: unknown,
): value is AirJamRuntimeOwnerCaptureResult =>
  isRecord(value) &&
  value.type === AIR_JAM_RUNTIME_OWNER_CAPTURE_RESULT &&
  typeof value.requestId === "string" &&
  typeof value.ok === "boolean" &&
  typeof value.capturedAt === "string" &&
  Array.isArray(value.screenshots) &&
  value.screenshots.every(isRuntimeOwnerScreenshot) &&
  (typeof value.error === "string" || value.error === null);

export const resolveProjectRelativeRuntimeCaptureDir = ({
  projectDir,
  relativeDir,
}: {
  projectDir: string;
  relativeDir: string;
}): string => {
  if (path.isAbsolute(relativeDir)) {
    throw new Error(
      "Runtime visual capture directory must be project-relative.",
    );
  }
  const resolved = path.resolve(projectDir, relativeDir);
  const relative = path.relative(projectDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      "Runtime visual capture directory must stay in the project.",
    );
  }
  return resolved;
};
