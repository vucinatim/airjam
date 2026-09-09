import {
  AIR_JAM_RUNTIME_INSPECTION_KEY,
  readRuntimeInspectionContract,
} from "@air-jam/sdk/runtime-inspection";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Frame,
  type FrameLocator,
  type Page,
} from "playwright-core";
import type {
  VisualHarnessMode,
  VisualHarnessPageSurface,
  VisualHarnessUrls,
  VisualQuerySurface,
  VisualViewport,
} from "./types.js";

export const DEFAULT_HOST_VIEWPORT: VisualViewport = {
  width: 1440,
  height: 1024,
};

export const DEFAULT_CONTROLLER_VIEWPORT: VisualViewport = {
  width: 390,
  height: 844,
};

const isEmbeddedMode = (mode: VisualHarnessMode): boolean =>
  mode !== "standalone-dev";

export const dismissHarnessControllerFullscreenPrompt = async (
  page: Page,
): Promise<boolean> => {
  const openPrompt = page.locator(
    '[data-testid="controller-fullscreen-prompt"][data-state="open"]',
  );
  await openPrompt
    .waitFor({ state: "visible", timeout: 5_000 })
    .catch(() => null);

  if (!(await openPrompt.isVisible().catch(() => false))) {
    return false;
  }

  await page
    .getByTestId("controller-fullscreen-prompt-dismiss")
    .click({ force: true });
  await openPrompt.waitFor({ state: "hidden", timeout: 10_000 });
  return true;
};

const waitForFrameToLoad = async ({
  page,
  testId,
  timeoutMs = 30_000,
}: {
  page: Page;
  testId: string;
  timeoutMs?: number;
}): Promise<FrameLocator> => {
  const iframe = page.getByTestId(testId);
  await iframe.waitFor({ state: "visible", timeout: timeoutMs });
  const iframeHandle = await iframe.elementHandle({ timeout: timeoutMs });
  if (!iframeHandle) {
    throw new Error(`Could not resolve iframe handle for "${testId}".`);
  }

  const startedAt = Date.now();
  let resolvedFrame: Frame | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    const nextFrame = await iframeHandle.contentFrame();
    const frameUrl = nextFrame?.url() ?? "";
    if (nextFrame && frameUrl.length > 0 && frameUrl !== "about:blank") {
      resolvedFrame = nextFrame;
      break;
    }
    await page.waitForTimeout(100);
  }

  if (!resolvedFrame) {
    throw new Error(`Timed out waiting for iframe "${testId}" to resolve.`);
  }

  await resolvedFrame.waitForLoadState("domcontentloaded", {
    timeout: Math.max(1, timeoutMs - (Date.now() - startedAt)),
  });
  return page.frameLocator(`iframe[data-testid="${testId}"]`);
};

const readRuntimeHref = async ({
  page,
  game,
  embedded,
}: {
  page: Page;
  game: VisualQuerySurface;
  embedded: boolean;
}): Promise<string> =>
  embedded
    ? game.locator("body").evaluate(() => window.location.href)
    : page.evaluate(() => window.location.href);

const readHostRuntimeInspection = async ({
  page,
  game,
  embedded,
}: {
  page: Page;
  game: VisualQuerySurface;
  embedded: boolean;
}) => {
  const rawInspection = embedded
    ? await game
        .locator("body")
        .evaluate(
          (_, key) =>
            (window as unknown as Record<string, unknown>)[key] ?? null,
          AIR_JAM_RUNTIME_INSPECTION_KEY,
        )
    : await page.evaluate(
        (key) => (window as unknown as Record<string, unknown>)[key] ?? null,
        AIR_JAM_RUNTIME_INSPECTION_KEY,
      );

  const inspection = readRuntimeInspectionContract({
    [AIR_JAM_RUNTIME_INSPECTION_KEY]: rawInspection,
  });
  return inspection?.role === "host" ? inspection : null;
};

const resolveControllerJoinUrl = async ({
  hostPage,
  hostGame,
  hostEmbedded,
  controllerBaseUrl,
}: {
  hostPage: Page;
  hostGame: VisualQuerySurface;
  hostEmbedded: boolean;
  controllerBaseUrl: string;
}): Promise<string> => {
  let resolvedJoinUrl: string | null = null;

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const inspection = await readHostRuntimeInspection({
      page: hostPage,
      game: hostGame,
      embedded: hostEmbedded,
    });
    if (inspection?.joinUrlStatus === "ready" && inspection.joinUrl) {
      resolvedJoinUrl = inspection.joinUrl;
    }

    if (!resolvedJoinUrl) {
      const runtimeUrl = new URL(
        await readRuntimeHref({
          page: hostPage,
          game: hostGame,
          embedded: hostEmbedded,
        }),
      );
      resolvedJoinUrl = runtimeUrl.searchParams.get("aj_join_url");
    }

    if (resolvedJoinUrl) {
      break;
    }
    await hostPage.waitForTimeout(250);
  }

  if (!resolvedJoinUrl) {
    throw new Error(
      "Could not resolve a controller join URL from the host runtime inspection contract or runtime URL.",
    );
  }

  const joinUrl = new URL(resolvedJoinUrl);
  const controllerUrl = new URL(controllerBaseUrl);
  joinUrl.protocol = controllerUrl.protocol;
  joinUrl.host = controllerUrl.host;
  return joinUrl.toString();
};

export type OpenVisualHarnessSessionOptions = {
  browser: Browser;
  urls: Omit<VisualHarnessUrls, "controllerJoinUrl">;
  mode: VisualHarnessMode;
};

type OpenVisualHarnessHostSessionResult = {
  urls: Omit<VisualHarnessUrls, "controllerJoinUrl"> & {
    controllerJoinUrl: null;
  };
  host: VisualHarnessPageSurface;
  close: () => Promise<void>;
};

export type OpenVisualHarnessSessionResult = {
  urls: VisualHarnessUrls;
  host: VisualHarnessPageSurface;
  controller: VisualHarnessPageSurface & {
    fullscreenPromptDismissed: boolean;
  };
  close: () => Promise<void>;
};

const openVisualHarnessHostSession = async ({
  browser,
  urls,
  mode,
}: OpenVisualHarnessSessionOptions): Promise<OpenVisualHarnessHostSessionResult> => {
  const embedded = isEmbeddedMode(mode);
  const hostContext: BrowserContext = await browser.newContext({
    viewport: DEFAULT_HOST_VIEWPORT,
  });

  try {
    const hostPage = await hostContext.newPage();
    await hostPage.goto(urls.hostUrl, { waitUntil: "domcontentloaded" });
    const hostGame: VisualQuerySurface = embedded
      ? await waitForFrameToLoad({
          page: hostPage,
          testId: "arcade-host-game-frame",
        })
      : hostPage;

    return {
      urls: { ...urls, controllerJoinUrl: null },
      host: {
        page: hostPage,
        game: hostGame,
        embedded,
      },
      close: () => hostContext.close(),
    };
  } catch (error) {
    await hostContext.close().catch(() => null);
    throw error;
  }
};

export const openVisualHarnessSession = async ({
  browser,
  urls,
  mode,
}: OpenVisualHarnessSessionOptions): Promise<OpenVisualHarnessSessionResult> => {
  const hostSession = await openVisualHarnessHostSession({
    browser,
    urls,
    mode,
  });
  const controllerContext = await browser.newContext({
    viewport: DEFAULT_CONTROLLER_VIEWPORT,
  });

  try {
    const controllerJoinUrl = await resolveControllerJoinUrl({
      hostPage: hostSession.host.page,
      hostGame: hostSession.host.game,
      hostEmbedded: hostSession.host.embedded,
      controllerBaseUrl: urls.controllerBaseUrl,
    });

    const controllerPage = await controllerContext.newPage();
    await controllerPage.goto(controllerJoinUrl, {
      waitUntil: "domcontentloaded",
    });
    const fullscreenPromptDismissed =
      await dismissHarnessControllerFullscreenPrompt(controllerPage);
    const controllerGame: VisualQuerySurface = hostSession.host.embedded
      ? await waitForFrameToLoad({
          page: controllerPage,
          testId: "arcade-controller-game-frame",
        })
      : controllerPage;

    return {
      urls: { ...hostSession.urls, controllerJoinUrl },
      host: hostSession.host,
      controller: {
        page: controllerPage,
        game: controllerGame,
        embedded: hostSession.host.embedded,
        fullscreenPromptDismissed,
      },
      close: async () => {
        await Promise.allSettled([
          hostSession.close(),
          controllerContext.close(),
        ]);
      },
    };
  } catch (error) {
    await Promise.allSettled([hostSession.close(), controllerContext.close()]);
    throw error;
  }
};

export const launchHarnessBrowser = async (): Promise<Browser> => {
  const options = {
    headless: true,
    args: [
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--use-angle=swiftshader",
    ],
  };

  if (process.env.AIRJAM_BROWSER_EXECUTABLE_PATH) {
    return chromium.launch({
      ...options,
      executablePath: process.env.AIRJAM_BROWSER_EXECUTABLE_PATH,
    });
  }

  try {
    return await chromium.launch(options);
  } catch (bundledBrowserError) {
    try {
      return await chromium.launch({ ...options, channel: "chrome" });
    } catch (systemBrowserError) {
      throw new Error(
        [
          "Air Jam could not launch a browser runtime for semantic sessions.",
          "Install Playwright Chromium or set AIRJAM_BROWSER_EXECUTABLE_PATH to a Chromium-compatible browser.",
          `Bundled browser: ${bundledBrowserError instanceof Error ? bundledBrowserError.message : String(bundledBrowserError)}`,
          `System Chrome: ${systemBrowserError instanceof Error ? systemBrowserError.message : String(systemBrowserError)}`,
        ].join("\n\n"),
      );
    }
  }
};
