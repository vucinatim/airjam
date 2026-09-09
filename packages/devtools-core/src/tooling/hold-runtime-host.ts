import {
  DEFAULT_CONTROLLER_VIEWPORT,
  DEFAULT_HOST_VIEWPORT,
  launchHarnessBrowser,
  openVisualHarnessSession,
  type VisualHarnessMode,
} from "@air-jam/harness/visual";
import {
  AIR_JAM_RUNTIME_INSPECTION_KEY,
  readRuntimeInspectionContract,
} from "@air-jam/sdk/runtime-inspection";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  AIR_JAM_RUNTIME_OWNER_CAPTURE_RESULT,
  isRuntimeOwnerCaptureRequest,
  resolveProjectRelativeRuntimeCaptureDir,
  type AirJamRuntimeOwnerCaptureResult,
} from "../runtime-owner-protocol.js";

const getFlagValue = (flag: string): string | null => {
  const inline = process.argv.find((value) => value.startsWith(`${flag}=`));
  if (inline) {
    return inline.slice(flag.length + 1);
  }

  const index = process.argv.indexOf(flag);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
};

const appOrigin = getFlagValue("--app-origin");
const hostUrl = getFlagValue("--host-url");
const controllerBaseUrl = getFlagValue("--controller-base-url");
const publicHost = getFlagValue("--public-host");
const localBuildUrl = getFlagValue("--local-build-url");
const browserBuildUrl = getFlagValue("--browser-build-url");
const roomId = getFlagValue("--room-id");
const requestedMode = getFlagValue("--mode") ?? "standalone-dev";
const timeoutMs = Number(getFlagValue("--timeout-ms") ?? "15000");

if (!appOrigin || !hostUrl || !controllerBaseUrl || !publicHost) {
  throw new Error(
    "Missing required isolated runtime host inputs. Expected resolved topology URLs.",
  );
}

const resolvedHostUrl = (() => {
  if (!roomId) {
    return hostUrl;
  }

  const nextUrl = new URL(hostUrl);
  nextUrl.searchParams.set("room", roomId);
  return nextUrl.toString();
})();

const browser = await launchHarnessBrowser();
const session = await openVisualHarnessSession({
  browser,
  mode: requestedMode as VisualHarnessMode,
  urls: {
    appOrigin,
    hostUrl: resolvedHostUrl,
    controllerBaseUrl,
    publicHost,
    localBuildUrl,
    browserBuildUrl,
  },
});

const shutdown = async (exitCode = 0) => {
  await Promise.allSettled([session.close(), browser.close()]);
  process.exit(exitCode);
};

process.on("message", (message: unknown) => {
  if (!isRuntimeOwnerCaptureRequest(message)) return;
  void (async () => {
    const capturedAt = new Date().toISOString();
    const response: AirJamRuntimeOwnerCaptureResult = {
      type: AIR_JAM_RUNTIME_OWNER_CAPTURE_RESULT,
      requestId: message.requestId,
      ok: false,
      capturedAt,
      screenshots: [],
      error: null,
    };
    try {
      const captureDir = resolveProjectRelativeRuntimeCaptureDir({
        projectDir: process.cwd(),
        relativeDir: message.relativeDir,
      });
      await mkdir(captureDir, { recursive: true });
      const captures = [
        {
          surface: "host" as const,
          fileName: "host-desktop.png",
          viewport: DEFAULT_HOST_VIEWPORT,
          page: session.host.page,
        },
        {
          surface: "controller" as const,
          fileName: "controller-phone.png",
          viewport: DEFAULT_CONTROLLER_VIEWPORT,
          page: session.controller.page,
        },
      ];
      for (const capture of captures) {
        await capture.page.waitForTimeout(300);
        const filePath = path.join(captureDir, capture.fileName);
        await capture.page.screenshot({ path: filePath, fullPage: true });
        response.screenshots.push({
          surface: capture.surface,
          width: capture.viewport.width,
          height: capture.viewport.height,
          relativePath: path.relative(process.cwd(), filePath),
        });
      }
      response.ok = true;
    } catch (error) {
      response.error = error instanceof Error ? error.message : String(error);
    }
    process.send?.(response);
  })();
});

process.on("SIGTERM", () => {
  void shutdown(0);
});

process.on("SIGINT", () => {
  void shutdown(0);
});

const readInspection = async () => {
  const rawValue = session.host.embedded
    ? await session.host.game
        .locator("body")
        .evaluate(
          (_, key) =>
            (window as unknown as Record<string, unknown>)[key] ?? null,
          AIR_JAM_RUNTIME_INSPECTION_KEY,
        )
    : await session.host.page.evaluate(
        (key) => (window as unknown as Record<string, unknown>)[key] ?? null,
        AIR_JAM_RUNTIME_INSPECTION_KEY,
      );

  return readRuntimeInspectionContract({
    [AIR_JAM_RUNTIME_INSPECTION_KEY]: rawValue,
  });
};

try {
  const startedAt = Date.now();
  let inspection = null;

  while (Date.now() - startedAt < timeoutMs) {
    const nextInspection = await readInspection();
    if (
      nextInspection?.role === "host" &&
      nextInspection.joinUrlStatus === "ready"
    ) {
      inspection = nextInspection;
      break;
    }

    await session.host.page.waitForTimeout(250);
  }

  if (!inspection || inspection.role !== "host") {
    throw new Error(
      "Timed out waiting for a published host runtime inspection contract.",
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        roomId: inspection.roomId,
        controllerJoinUrl: inspection.joinUrl,
        inspection,
      },
      null,
      2,
    )}\n`,
  );

  await new Promise(() => {
    // Keep the hidden host runtime alive until the parent process disconnects it.
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await shutdown(1);
}
