import { lookup } from "node:dns/promises";
import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import tls from "node:tls";
import { PLATFORM_READINESS_PATH } from "../src/lib/platform-service-contract";
import { HOSTED_RELEASE_CONTROLLER_PATH } from "../src/lib/releases/hosted-release-artifact";
import { inspectHostedReleaseCookieSiteIsolation } from "../src/lib/releases/hosted-release-cookie-site";
import { createHostedReleaseSecurityHeaders } from "../src/lib/releases/hosted-release-response-policy";
import { assessReleaseOriginAddresses } from "../src/lib/releases/release-origin-network-policy";

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_READINESS_RESPONSE_BYTES = 64 * 1024;

export type RemotePlatformDeploymentIdentity = {
  provider: string | null;
  environment: string | null;
  deploymentId: string | null;
  revision: string | null;
};

export type RemoteHostedReleaseOriginAssessment = {
  required: boolean;
  status: "ready" | "disabled" | "invalid";
  publicOrigin: string | null;
  reason: string | null;
};

export type RemotePlatformRequestPolicy = {
  platformPublicOrigin: string;
  isRailwayPreviewEnvironment: boolean;
  platformRequestHosts: string[];
};

export type RemoteReleaseOriginReadiness = {
  readiness: { httpStatus: 200 | 503; ok: boolean };
  deployment: RemotePlatformDeploymentIdentity;
  requestPolicy: RemotePlatformRequestPolicy;
  assessment: RemoteHostedReleaseOriginAssessment;
};

export class ReleaseOriginOperatorError extends Error {
  constructor(
    readonly code:
      | "INVALID_PLATFORM_URL"
      | "INVALID_RELEASE_URL"
      | "REMOTE_REQUEST_FAILED"
      | "REMOTE_HTTP_ERROR"
      | "REMOTE_CONTRACT_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ReleaseOriginOperatorError";
  }
}

const requireNullableString = (
  record: Record<string, unknown>,
  key: string,
): string | null => {
  const value = record[key];
  if (value !== null && typeof value !== "string") {
    throw new ReleaseOriginOperatorError(
      "REMOTE_CONTRACT_INVALID",
      `Remote platform readiness ${key} is invalid.`,
    );
  }
  return value ?? null;
};

export const parseRemoteReleaseOriginReadiness = (
  value: unknown,
  httpStatus: 200 | 503,
): RemoteReleaseOriginReadiness => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReleaseOriginOperatorError(
      "REMOTE_CONTRACT_INVALID",
      "Remote platform readiness response is not the expected object contract.",
    );
  }

  const readiness = value as Record<string, unknown>;
  const deployment = readiness.deployment;
  const boundaries = readiness.boundaries;
  const boundary =
    boundaries && typeof boundaries === "object" && !Array.isArray(boundaries)
      ? (boundaries as Record<string, unknown>).hostedReleaseOrigin
      : null;
  const requestPolicy =
    boundaries && typeof boundaries === "object" && !Array.isArray(boundaries)
      ? (boundaries as Record<string, unknown>).platformRequestPolicy
      : null;
  if (
    typeof readiness.ok !== "boolean" ||
    readiness.service !== "platform" ||
    !deployment ||
    typeof deployment !== "object" ||
    Array.isArray(deployment) ||
    !requestPolicy ||
    typeof requestPolicy !== "object" ||
    Array.isArray(requestPolicy) ||
    !boundary ||
    typeof boundary !== "object" ||
    Array.isArray(boundary)
  ) {
    throw new ReleaseOriginOperatorError(
      "REMOTE_CONTRACT_INVALID",
      "Remote platform readiness response does not contain deployment, request-policy, and hosted-release boundary contracts.",
    );
  }
  if (
    (httpStatus === 200 && !readiness.ok) ||
    (httpStatus === 503 && readiness.ok)
  ) {
    throw new ReleaseOriginOperatorError(
      "REMOTE_CONTRACT_INVALID",
      "Remote platform readiness status does not match its HTTP status.",
    );
  }

  const deploymentRecord = deployment as Record<string, unknown>;
  const parsedDeployment: RemotePlatformDeploymentIdentity = {
    provider: requireNullableString(deploymentRecord, "provider"),
    environment: requireNullableString(deploymentRecord, "environment"),
    deploymentId: requireNullableString(deploymentRecord, "deploymentId"),
    revision: requireNullableString(deploymentRecord, "revision"),
  };

  const requestPolicyRecord = requestPolicy as Record<string, unknown>;
  if (
    typeof requestPolicyRecord.platformPublicOrigin !== "string" ||
    typeof requestPolicyRecord.isRailwayPreviewEnvironment !== "boolean" ||
    !Array.isArray(requestPolicyRecord.platformRequestHosts) ||
    !requestPolicyRecord.platformRequestHosts.every(
      (host) => typeof host === "string" && host.length > 0,
    )
  ) {
    throw new ReleaseOriginOperatorError(
      "REMOTE_CONTRACT_INVALID",
      "Remote platform request policy has invalid origin, environment, or host fields.",
    );
  }
  const platformPublicOrigin = parseOrigin(
    requestPolicyRecord.platformPublicOrigin,
    "REMOTE_CONTRACT_INVALID",
    "Remote platform request policy public origin is not a valid http(s) origin.",
  );
  const platformRequestHosts = requestPolicyRecord.platformRequestHosts;
  if (!platformRequestHosts.includes(new URL(platformPublicOrigin).host)) {
    throw new ReleaseOriginOperatorError(
      "REMOTE_CONTRACT_INVALID",
      "Remote platform request policy does not admit its own public origin host.",
    );
  }
  const parsedRequestPolicy: RemotePlatformRequestPolicy = {
    platformPublicOrigin,
    isRailwayPreviewEnvironment:
      requestPolicyRecord.isRailwayPreviewEnvironment,
    platformRequestHosts,
  };

  const assessment = boundary as Record<string, unknown>;
  const status = assessment.status;
  if (
    typeof assessment.required !== "boolean" ||
    (status !== "ready" && status !== "disabled" && status !== "invalid")
  ) {
    throw new ReleaseOriginOperatorError(
      "REMOTE_CONTRACT_INVALID",
      "Remote hosted-release origin assessment has invalid required or status fields.",
    );
  }
  const expectedReadiness = !assessment.required || status === "ready";
  if (readiness.ok !== expectedReadiness) {
    throw new ReleaseOriginOperatorError(
      "REMOTE_CONTRACT_INVALID",
      "Remote platform readiness does not match the hosted-release boundary state.",
    );
  }

  if (status === "ready") {
    if (
      typeof assessment.publicOrigin !== "string" ||
      assessment.reason !== null
    ) {
      throw new ReleaseOriginOperatorError(
        "REMOTE_CONTRACT_INVALID",
        "Remote ready assessment has invalid publicOrigin or reason fields.",
      );
    }
    const publicOrigin = parseOrigin(
      assessment.publicOrigin,
      "REMOTE_CONTRACT_INVALID",
      "Remote ready assessment publicOrigin is not a valid http(s) origin.",
    );
    return {
      readiness: { httpStatus, ok: readiness.ok },
      deployment: parsedDeployment,
      requestPolicy: parsedRequestPolicy,
      assessment: {
        required: assessment.required,
        status,
        publicOrigin,
        reason: null,
      },
    };
  }

  if (
    assessment.publicOrigin !== null ||
    typeof assessment.reason !== "string" ||
    assessment.reason.length === 0
  ) {
    throw new ReleaseOriginOperatorError(
      "REMOTE_CONTRACT_INVALID",
      "Remote unavailable assessment has invalid publicOrigin or reason fields.",
    );
  }
  return {
    readiness: { httpStatus, ok: readiness.ok },
    deployment: parsedDeployment,
    requestPolicy: parsedRequestPolicy,
    assessment: {
      required: assessment.required,
      status,
      publicOrigin: null,
      reason: assessment.reason,
    },
  };
};

const parseOrigin = (
  rawUrl: string,
  code: ReleaseOriginOperatorError["code"],
  message: string,
): string => {
  try {
    const url = new URL(rawUrl);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("invalid origin");
    }
    return url.origin;
  } catch {
    throw new ReleaseOriginOperatorError(code, message);
  }
};

const normalizeHostname = (hostname: string): string =>
  hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = normalizeHostname(hostname);
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost")
  );
};

export const parsePlatformOrigin = (rawUrl: string): string => {
  const origin = parseOrigin(
    rawUrl,
    "INVALID_PLATFORM_URL",
    "--platform-url must be an absolute http(s) origin without credentials, a path, query, or fragment.",
  );
  const url = new URL(origin);
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new ReleaseOriginOperatorError(
      "INVALID_PLATFORM_URL",
      "--platform-url must use HTTPS except for explicit loopback diagnostics.",
    );
  }
  return origin;
};

const parseReleaseUrl = (rawUrl: string): URL => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ReleaseOriginOperatorError(
      "INVALID_RELEASE_URL",
      "--release-url must be an absolute canonical hosted-release URL.",
    );
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) ||
    !/^\/releases\/g\/[^/]+\/r\/[^/]+\/generations\/[^/]+$/.test(url.pathname)
  ) {
    throw new ReleaseOriginOperatorError(
      "INVALID_RELEASE_URL",
      "--release-url must use HTTPS except for loopback diagnostics and identify the exact /releases/g/{gameId}/r/{releaseId}/generations/{generationId} host root without credentials, a query, a fragment, or a trailing slash.",
    );
  }
  return url;
};

type Check = {
  id: string;
  status: "passed" | "failed";
  summary: string;
  evidence?: Record<string, boolean | number | string | null>;
};

const check = (
  id: string,
  passed: boolean,
  summary: string,
  evidence?: Check["evidence"],
): Check => ({
  id,
  status: passed ? "passed" : "failed",
  summary,
  ...(evidence ? { evidence } : {}),
});

type OriginResolution = {
  address: string;
  family: 4 | 6;
  allAddressesPublic: boolean;
};

const resolveOrigin = async (
  origin: URL,
): Promise<{ resolution: OriginResolution | null; check: Check }> => {
  let timeout: NodeJS.Timeout | null = null;
  try {
    const addresses = await Promise.race([
      lookup(normalizeHostname(origin.hostname), { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("DNS timeout")),
          REQUEST_TIMEOUT_MS,
        );
      }),
    ]);
    const normalized = addresses.filter(
      (entry): entry is { address: string; family: 4 | 6 } =>
        entry.family === 4 || entry.family === 6,
    );
    const addressAssessment = assessReleaseOriginAddresses({
      hostnameIsLoopback: isLoopbackHostname(origin.hostname),
      addresses: normalized,
    });
    const allAddressesPublic = addressAssessment.allAddressesPublic;
    const loopbackDiagnostic = addressAssessment.mode === "loopback-diagnostic";
    const usable = addressAssessment.mode !== "rejected";
    return {
      resolution: usable
        ? {
            address: normalized[0]!.address,
            family: normalized[0]!.family,
            allAddressesPublic,
          }
        : null,
      check: check(
        `network.${origin.hostname}.dns`,
        usable,
        usable
          ? loopbackDiagnostic
            ? "DNS resolved the explicit loopback diagnostic origin."
            : "DNS resolved only publicly routable addresses."
          : "DNS did not resolve to an allowed address set.",
        {
          addressCount: normalized.length,
          allAddressesPublic,
          allAddressesLoopback: addressAssessment.allAddressesLoopback,
          loopbackDiagnostic,
        },
      ),
    };
  } catch {
    return {
      resolution: null,
      check: check(
        `network.${origin.hostname}.dns`,
        false,
        "DNS resolution failed or timed out.",
        { addressCount: 0, allAddressesPublic: false },
      ),
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

type PinnedResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
};

const requestPinned = async (
  url: URL,
  resolution: OriginResolution,
  options: {
    method?: "GET" | "POST" | "OPTIONS";
    headers?: Record<string, string>;
    body?: string;
    captureBody?: boolean;
  } = {},
): Promise<PinnedResponse> =>
  await new Promise((resolve, reject) => {
    let settled = false;
    let absoluteTimeout: NodeJS.Timeout | null = null;
    const body = options.body ?? null;
    const headers: Record<string, string> = {
      accept: "*/*",
      host: url.host,
      ...(options.headers ?? {}),
    };
    if (body !== null) {
      headers["content-length"] = Buffer.byteLength(body).toString();
    }
    const finish = (
      outcome:
        | { ok: true; response: PinnedResponse }
        | { ok: false; error: ReleaseOriginOperatorError },
    ) => {
      if (settled) return;
      settled = true;
      if (absoluteTimeout) clearTimeout(absoluteTimeout);
      if (outcome.ok) resolve(outcome.response);
      else reject(outcome.error);
    };
    const transport = url.protocol === "https:" ? https : http;
    const originalHostname = normalizeHostname(url.hostname);
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: resolution.address,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        method: options.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        headers,
        ...(url.protocol === "https:"
          ? {
              ...(isIP(originalHostname) === 0
                ? { servername: originalHostname }
                : {}),
              rejectUnauthorized: true,
            }
          : {}),
      },
      (response) => {
        if (!options.captureBody) {
          const result = {
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: "",
          };
          response.destroy();
          finish({ ok: true, response: result });
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.byteLength;
          if (size > MAX_READINESS_RESPONSE_BYTES) {
            request.destroy();
            finish({
              ok: false,
              error: new ReleaseOriginOperatorError(
                "REMOTE_CONTRACT_INVALID",
                "Attestation response exceeded the size limit.",
              ),
            });
            return;
          }
          chunks.push(bytes);
        });
        response.once("error", () =>
          finish({
            ok: false,
            error: new ReleaseOriginOperatorError(
              "REMOTE_REQUEST_FAILED",
              "Attestation response failed.",
            ),
          }),
        );
        response.once("end", () =>
          finish({
            ok: true,
            response: {
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            },
          }),
        );
      },
    );
    absoluteTimeout = setTimeout(() => {
      request.destroy();
      finish({
        ok: false,
        error: new ReleaseOriginOperatorError(
          "REMOTE_REQUEST_FAILED",
          `Attestation request exceeded the absolute ${REQUEST_TIMEOUT_MS}ms deadline.`,
        ),
      });
    }, REQUEST_TIMEOUT_MS);
    request.once("error", (error) =>
      finish({
        ok: false,
        error:
          error instanceof ReleaseOriginOperatorError
            ? error
            : new ReleaseOriginOperatorError(
                "REMOTE_REQUEST_FAILED",
                "Attestation request failed.",
              ),
      }),
    );
    if (body !== null) request.write(body);
    request.end();
  });

const header = (response: PinnedResponse, name: string): string | null => {
  const value = response.headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : (value ?? null);
};

const hasHeader = (response: PinnedResponse, name: string): boolean =>
  response.headers[name.toLowerCase()] !== undefined;

const hasNoStore = (response: PinnedResponse): boolean =>
  (header(response, "cache-control") ?? "")
    .toLowerCase()
    .split(",")
    .some((value) => value.trim() === "no-store");

const attestTls = async (
  origin: URL,
  resolution: OriginResolution,
): Promise<Check> => {
  if (origin.protocol === "http:" && isLoopbackHostname(origin.hostname)) {
    return check(
      `network.${origin.hostname}.tls`,
      true,
      "TLS is intentionally not applicable to loopback diagnostics.",
      { mode: "loopback-http" },
    );
  }
  return await new Promise((resolve) => {
    let settled = false;
    let absoluteTimeout: NodeJS.Timeout | null = null;
    const socket = tls.connect({
      host: resolution.address,
      port: Number(origin.port || 443),
      ...(isIP(normalizeHostname(origin.hostname)) === 0
        ? { servername: normalizeHostname(origin.hostname) }
        : {}),
      rejectUnauthorized: true,
    });
    const finish = (value: Check) => {
      if (settled) return;
      settled = true;
      if (absoluteTimeout) clearTimeout(absoluteTimeout);
      socket.destroy();
      resolve(value);
    };
    absoluteTimeout = setTimeout(
      () =>
        finish(
          check(
            `network.${origin.hostname}.tls`,
            false,
            `TLS negotiation exceeded the absolute ${REQUEST_TIMEOUT_MS}ms deadline.`,
          ),
        ),
      REQUEST_TIMEOUT_MS,
    );
    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate();
      finish(
        check(
          `network.${origin.hostname}.tls`,
          socket.authorized,
          socket.authorized
            ? "TLS certificate validation succeeded against the pinned address."
            : "TLS certificate validation failed.",
          {
            protocol: socket.getProtocol(),
            certificateValidTo: certificate.valid_to || null,
          },
        ),
      );
    });
    socket.once("error", () =>
      finish(
        check(
          `network.${origin.hostname}.tls`,
          false,
          "TLS certificate validation failed.",
        ),
      ),
    );
  });
};

const readReadiness = async (
  platformOrigin: string,
  resolution: OriginResolution,
): Promise<RemoteReleaseOriginReadiness> => {
  const response = await requestPinned(
    new URL(PLATFORM_READINESS_PATH, platformOrigin),
    resolution,
    { headers: { accept: "application/json" }, captureBody: true },
  );
  if (response.status !== 200 && response.status !== 503) {
    throw new ReleaseOriginOperatorError(
      "REMOTE_HTTP_ERROR",
      `Remote platform readiness request returned HTTP ${response.status}.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new ReleaseOriginOperatorError(
      "REMOTE_CONTRACT_INVALID",
      "Remote platform readiness response is not valid JSON.",
    );
  }
  const readiness = parseRemoteReleaseOriginReadiness(
    parsed,
    response.status as 200 | 503,
  );
  if (readiness.requestPolicy.platformPublicOrigin !== platformOrigin) {
    throw new ReleaseOriginOperatorError(
      "REMOTE_CONTRACT_INVALID",
      `Remote platform request policy identifies ${readiness.requestPolicy.platformPublicOrigin}, not the inspected origin ${platformOrigin}.`,
    );
  }
  return readiness;
};

export type RemoteReleaseOriginInspectionResult =
  RemoteReleaseOriginReadiness & {
    source: { type: "remote"; platformOrigin: string };
  };

export const inspectRemoteReleaseOrigin = async (
  rawPlatformUrl: string,
): Promise<RemoteReleaseOriginInspectionResult> => {
  const platformOrigin = parsePlatformOrigin(rawPlatformUrl);
  const platformUrl = new URL(platformOrigin);
  const resolved = await resolveOrigin(platformUrl);
  if (!resolved.resolution) {
    throw new ReleaseOriginOperatorError(
      "REMOTE_REQUEST_FAILED",
      "Remote platform DNS did not resolve to an allowed address set.",
    );
  }

  return {
    source: { type: "remote", platformOrigin },
    ...(await readReadiness(platformOrigin, resolved.resolution)),
  };
};

const responseEvidence = (response: PinnedResponse) => ({
  httpStatus: response.status,
  cacheControl: header(response, "cache-control"),
  contentClass: header(response, "x-airjam-content-class"),
});

const attestReleaseDocument = async ({
  id,
  platformOrigin,
  resolution,
  url,
}: {
  id: string;
  platformOrigin: string;
  resolution: OriginResolution;
  url: URL;
}): Promise<Check> => {
  try {
    const response = await requestPinned(url, resolution);
    const expectedHeaders = new Map(
      createHostedReleaseSecurityHeaders({
        platformPublicOrigin: platformOrigin,
        allowInsecureDevFrames: isLoopbackHostname(url.hostname),
      }).map((entry) => [entry.key.toLowerCase(), entry.value]),
    );
    const exactPolicy = [...expectedHeaders].every(
      ([name, value]) => header(response, name) === value,
    );
    const passed =
      response.status === 200 &&
      (header(response, "content-type") ?? "")
        .toLowerCase()
        .startsWith("text/html") &&
      exactPolicy &&
      !hasHeader(response, "x-frame-options") &&
      !hasHeader(response, "set-cookie");
    return check(
      id,
      passed,
      "The exact live release document carries the isolated HTML policy and sets no cookie.",
      {
        ...responseEvidence(response),
        contentType: header(response, "content-type"),
        exactPolicy,
        contentTypeOptionsExact:
          header(response, "x-content-type-options") === "nosniff",
        setCookiePresent: hasHeader(response, "set-cookie"),
      },
    );
  } catch {
    return check(
      id,
      false,
      "The exact live release response policy could not be attested.",
    );
  }
};

const attestPlatformRedirect = async ({
  id,
  platformOrigin,
  platformResolution,
  releaseUrl,
}: {
  id: string;
  platformOrigin: string;
  platformResolution: OriginResolution;
  releaseUrl: URL;
}): Promise<Check> => {
  try {
    const response = await requestPinned(
      new URL(releaseUrl.pathname, platformOrigin),
      platformResolution,
    );
    const location = header(response, "location");
    return check(
      id,
      response.status === 307 &&
        hasNoStore(response) &&
        location === releaseUrl.toString(),
      "The platform release path redirects temporarily and without caching to the exact release URL.",
      { ...responseEvidence(response), location },
    );
  } catch {
    return check(
      id,
      false,
      "The platform-to-release redirect could not be attested.",
    );
  }
};

const attestCors = async ({
  id,
  platformOrigin,
  platformResolution,
  releaseOrigin,
  path,
  expectedStatus,
  expectedErrorCode,
  method = "GET",
  body,
}: {
  id: string;
  platformOrigin: string;
  platformResolution: OriginResolution;
  releaseOrigin: string;
  path: string;
  expectedStatus: number;
  expectedErrorCode: string;
  method?: "GET" | "POST";
  body?: string;
}): Promise<Check> => {
  try {
    const response = await requestPinned(
      new URL(path, platformOrigin),
      platformResolution,
      {
        method,
        body,
        captureBody: true,
        headers: {
          origin: releaseOrigin,
          ...(body ? { "content-type": "application/json" } : {}),
        },
      },
    );
    const allowOrigin = header(response, "access-control-allow-origin");
    const credentials = header(response, "access-control-allow-credentials");
    let errorCodeMatched = false;
    try {
      const parsed = JSON.parse(response.body) as unknown;
      const visit = (value: unknown): boolean => {
        if (!value || typeof value !== "object") return false;
        if (Array.isArray(value)) return value.some(visit);
        return Object.entries(value as Record<string, unknown>).some(
          ([key, entry]) =>
            ((key === "error" || key === "code") &&
              entry === expectedErrorCode) ||
            visit(entry),
        );
      };
      errorCodeMatched = visit(parsed);
    } catch {
      errorCodeMatched = false;
    }
    const jsonContentType = (header(response, "content-type") ?? "")
      .toLowerCase()
      .startsWith("application/json");
    return check(
      id,
      response.status === expectedStatus &&
        jsonContentType &&
        errorCodeMatched &&
        allowOrigin !== releaseOrigin &&
        allowOrigin !== "*" &&
        credentials !== "true",
      "The protected endpoint returns its expected unauthenticated contract without granting release-origin CORS.",
      {
        httpStatus: response.status,
        expectedStatus,
        jsonContentType,
        errorCodeMatched,
        releaseOriginAllowed:
          allowOrigin === releaseOrigin || allowOrigin === "*",
        credentialsAllowed: credentials === "true",
      },
    );
  } catch {
    return check(
      id,
      false,
      "The protected endpoint CORS contract could not be attested.",
    );
  }
};

const attestAnonymousSessionCors = async ({
  platformOrigin,
  platformResolution,
  releaseOrigin,
}: {
  platformOrigin: string;
  platformResolution: OriginResolution;
  releaseOrigin: string;
}): Promise<Check> => {
  try {
    const response = await requestPinned(
      new URL("/api/auth/get-session", platformOrigin),
      platformResolution,
      {
        captureBody: true,
        headers: { origin: releaseOrigin },
      },
    );
    const allowOrigin = header(response, "access-control-allow-origin");
    const credentials = header(response, "access-control-allow-credentials");
    const jsonContentType = (header(response, "content-type") ?? "")
      .toLowerCase()
      .startsWith("application/json");
    let anonymousSession = false;
    try {
      anonymousSession = JSON.parse(response.body) === null;
    } catch {
      anonymousSession = false;
    }
    return check(
      "cors.browser-session",
      response.status === 200 &&
        jsonContentType &&
        anonymousSession &&
        allowOrigin !== releaseOrigin &&
        allowOrigin !== "*" &&
        credentials !== "true" &&
        !hasHeader(response, "set-cookie"),
      "The browser-session endpoint returns the anonymous contract without granting release-origin CORS or setting a cookie.",
      {
        httpStatus: response.status,
        jsonContentType,
        anonymousSession,
        releaseOriginAllowed:
          allowOrigin === releaseOrigin || allowOrigin === "*",
        credentialsAllowed: credentials === "true",
        setCookiePresent: hasHeader(response, "set-cookie"),
      },
    );
  } catch {
    return check(
      "cors.browser-session",
      false,
      "The browser-session CORS contract could not be attested.",
    );
  }
};

const attestCorsPreflight = async ({
  id,
  platformOrigin,
  platformResolution,
  releaseOrigin,
  path,
}: {
  id: string;
  platformOrigin: string;
  platformResolution: OriginResolution;
  releaseOrigin: string;
  path: string;
}): Promise<Check> => {
  try {
    const response = await requestPinned(
      new URL(path, platformOrigin),
      platformResolution,
      {
        method: "OPTIONS",
        headers: {
          origin: releaseOrigin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      },
    );
    const allowOrigin = header(response, "access-control-allow-origin");
    const allowCredentials = header(
      response,
      "access-control-allow-credentials",
    );
    const allowMethods = header(response, "access-control-allow-methods");
    const denied =
      allowOrigin !== releaseOrigin &&
      allowOrigin !== "*" &&
      allowCredentials !== "true" &&
      !(allowMethods ?? "")
        .toUpperCase()
        .split(",")
        .map((value) => value.trim())
        .includes("POST");
    return check(
      id,
      denied,
      "The protected JSON endpoint denies release-origin browser preflight authority.",
      {
        httpStatus: response.status,
        releaseOriginAllowed:
          allowOrigin === releaseOrigin || allowOrigin === "*",
        credentialsAllowed: allowCredentials === "true",
        postAllowed: (allowMethods ?? "")
          .toUpperCase()
          .split(",")
          .map((value) => value.trim())
          .includes("POST"),
      },
    );
  } catch {
    return check(
      id,
      false,
      "The protected endpoint preflight contract could not be attested.",
    );
  }
};

export type ReleaseOriginAttestationResult = {
  status: "passed" | "failed";
  evidenceKind: "diagnostic" | "production-deployment";
  productionEvidenceCandidate: boolean;
  productionEvidenceEligible: boolean;
  providerVerification: {
    status: "not-performed";
    provider: "railway";
  };
  attestedAt: string;
  source: {
    platformOrigin: string;
    releaseOrigin: string;
    releaseUrl: string;
    controllerUrl: string;
    deployment: RemotePlatformDeploymentIdentity;
  };
  checks: Check[];
  summary: { passed: number; failed: number };
};

const summarize = ({
  attestedAt,
  checks,
  controllerUrl,
  deployment,
  platformOrigin,
  platformResolution,
  releaseUrl,
  releaseResolution,
}: {
  attestedAt: string;
  checks: Check[];
  controllerUrl: URL;
  deployment: RemotePlatformDeploymentIdentity;
  platformOrigin: string;
  platformResolution: OriginResolution | null;
  releaseUrl: URL;
  releaseResolution: OriginResolution | null;
}): ReleaseOriginAttestationResult => {
  const passed = checks.filter((item) => item.status === "passed").length;
  const failed = checks.length - passed;
  const releaseOrigin = releaseUrl.origin;
  const productionIdentity =
    deployment.provider === "railway" &&
    deployment.environment === "production" &&
    Boolean(deployment.deploymentId) &&
    Boolean(deployment.revision);
  const productionNetwork =
    new URL(platformOrigin).protocol === "https:" &&
    releaseUrl.protocol === "https:" &&
    !isLoopbackHostname(new URL(platformOrigin).hostname) &&
    !isLoopbackHostname(releaseUrl.hostname) &&
    platformResolution?.allAddressesPublic === true &&
    releaseResolution?.allAddressesPublic === true;
  const productionEvidenceCandidate =
    failed === 0 && productionIdentity && productionNetwork;
  return {
    status: failed === 0 ? "passed" : "failed",
    evidenceKind: "diagnostic",
    productionEvidenceCandidate,
    productionEvidenceEligible: false,
    providerVerification: {
      status: "not-performed",
      provider: "railway",
    },
    attestedAt,
    source: {
      platformOrigin,
      releaseOrigin,
      releaseUrl: releaseUrl.toString(),
      controllerUrl: controllerUrl.toString(),
      deployment,
    },
    checks,
    summary: { passed, failed },
  };
};

export const attestRemoteReleaseOrigin = async ({
  platformUrl: rawPlatformUrl,
  releaseUrl: rawReleaseUrl,
}: {
  platformUrl: string;
  releaseUrl: string;
}): Promise<ReleaseOriginAttestationResult> => {
  const attestedAt = new Date().toISOString();
  const platformOrigin = parsePlatformOrigin(rawPlatformUrl);
  const releaseUrl = parseReleaseUrl(rawReleaseUrl);
  const controllerUrl = new URL(
    `${releaseUrl.pathname}${HOSTED_RELEASE_CONTROLLER_PATH}`,
    releaseUrl.origin,
  );
  const platformUrl = new URL(platformOrigin);
  const releaseOriginUrl = new URL(releaseUrl.origin);
  const cookieSite = inspectHostedReleaseCookieSiteIsolation({
    platformHostname: platformUrl.hostname,
    releaseHostname: releaseOriginUrl.hostname,
  });
  const [platformDns, releaseDns] = await Promise.all([
    resolveOrigin(platformUrl),
    resolveOrigin(releaseOriginUrl),
  ]);
  const checks: Check[] = [
    check(
      "boundary.cookie-site-isolation",
      cookieSite.isolated,
      "The release origin uses a cookie site distinct from the authenticated platform.",
      {
        platformCookieSite: cookieSite.platformCookieSite,
        releaseCookieSite: cookieSite.releaseCookieSite,
      },
    ),
    platformDns.check,
    releaseDns.check,
  ];
  const noDeployment: RemotePlatformDeploymentIdentity = {
    provider: null,
    environment: null,
    deploymentId: null,
    revision: null,
  };
  const finish = (deployment = noDeployment) =>
    summarize({
      attestedAt,
      checks,
      controllerUrl,
      deployment,
      platformOrigin,
      platformResolution: platformDns.resolution,
      releaseUrl,
      releaseResolution: releaseDns.resolution,
    });
  if (!cookieSite.isolated || !platformDns.resolution || !releaseDns.resolution)
    return finish();

  checks.push(
    ...(await Promise.all([
      attestTls(platformUrl, platformDns.resolution),
      attestTls(releaseOriginUrl, releaseDns.resolution),
    ])),
  );

  let initialReadiness: RemoteReleaseOriginReadiness;
  try {
    initialReadiness = await readReadiness(
      platformOrigin,
      platformDns.resolution,
    );
  } catch {
    checks.push(
      check(
        "platform.readiness-boundary",
        false,
        "The deployed platform readiness boundary could not be attested.",
      ),
    );
    return finish();
  }
  const boundaryReady =
    initialReadiness.readiness.httpStatus === 200 &&
    initialReadiness.readiness.ok &&
    initialReadiness.assessment.status === "ready" &&
    initialReadiness.assessment.required &&
    initialReadiness.assessment.publicOrigin === releaseUrl.origin;
  checks.push(
    check(
      "platform.readiness-boundary",
      boundaryReady,
      "The platform reports this exact release origin as its ready required boundary.",
      {
        httpStatus: initialReadiness.readiness.httpStatus,
        required: initialReadiness.assessment.required,
        exactReleaseOrigin:
          initialReadiness.assessment.publicOrigin === releaseUrl.origin,
      },
    ),
  );
  if (!boundaryReady) return finish(initialReadiness.deployment);

  checks.push(
    ...(await Promise.all([
      attestPlatformRedirect({
        id: "routing.platform-host-to-release",
        platformOrigin,
        platformResolution: platformDns.resolution,
        releaseUrl,
      }),
      attestPlatformRedirect({
        id: "routing.platform-controller-to-release",
        platformOrigin,
        platformResolution: platformDns.resolution,
        releaseUrl: controllerUrl,
      }),
    ])),
  );

  try {
    const response = await requestPinned(
      new URL("/dashboard", releaseUrl.origin),
      releaseDns.resolution,
    );
    checks.push(
      check(
        "routing.release-host-platform-block",
        response.status === 404 &&
          hasNoStore(response) &&
          header(response, "x-airjam-content-class") === "untrusted-release" &&
          !hasHeader(response, "set-cookie"),
        "The release host blocks platform routes without setting cookies.",
        {
          ...responseEvidence(response),
          setCookiePresent: hasHeader(response, "set-cookie"),
        },
      ),
    );
  } catch {
    checks.push(
      check(
        "routing.release-host-platform-block",
        false,
        "The release-host platform-route block could not be attested.",
      ),
    );
  }

  checks.push(
    ...(await Promise.all([
      attestReleaseDocument({
        id: "response.host-release-policy",
        platformOrigin,
        resolution: releaseDns.resolution,
        url: releaseUrl,
      }),
      attestReleaseDocument({
        id: "response.controller-release-policy",
        platformOrigin,
        resolution: releaseDns.resolution,
        url: controllerUrl,
      }),
      attestCors({
        id: "cors.machine-auth",
        platformOrigin,
        platformResolution: platformDns.resolution,
        releaseOrigin: releaseUrl.origin,
        path: "/api/cli/auth/me",
        expectedStatus: 401,
        expectedErrorCode: "unauthorized",
      }),
      attestAnonymousSessionCors({
        platformOrigin,
        platformResolution: platformDns.resolution,
        releaseOrigin: releaseUrl.origin,
      }),
      attestCors({
        id: "cors.dashboard-api",
        platformOrigin,
        platformResolution: platformDns.resolution,
        releaseOrigin: releaseUrl.origin,
        path: "/api/trpc/game.list?input=%7B%7D",
        expectedStatus: 401,
        expectedErrorCode: "UNAUTHORIZED",
      }),
      attestCors({
        id: "cors.device-poll",
        platformOrigin,
        platformResolution: platformDns.resolution,
        releaseOrigin: releaseUrl.origin,
        path: "/api/cli/auth/device/poll",
        expectedStatus: 400,
        expectedErrorCode: "validation_failed",
        method: "POST",
        body: "{}",
      }),
      attestCors({
        id: "cors.device-approval",
        platformOrigin,
        platformResolution: platformDns.resolution,
        releaseOrigin: releaseUrl.origin,
        path: "/api/cli/auth/device/approve",
        expectedStatus: 401,
        expectedErrorCode: "unauthorized",
        method: "POST",
        body: JSON.stringify({ userCode: "AIRJAM-ATTESTATION" }),
      }),
      attestCorsPreflight({
        id: "cors.device-poll-preflight",
        platformOrigin,
        platformResolution: platformDns.resolution,
        releaseOrigin: releaseUrl.origin,
        path: "/api/cli/auth/device/poll",
      }),
      attestCorsPreflight({
        id: "cors.device-approval-preflight",
        platformOrigin,
        platformResolution: platformDns.resolution,
        releaseOrigin: releaseUrl.origin,
        path: "/api/cli/auth/device/approve",
      }),
    ])),
  );

  try {
    const finalReadiness = await readReadiness(
      platformOrigin,
      platformDns.resolution,
    );
    const stableDeployment =
      JSON.stringify(finalReadiness.deployment) ===
      JSON.stringify(initialReadiness.deployment);
    const stableReadiness =
      finalReadiness.readiness.httpStatus ===
        initialReadiness.readiness.httpStatus &&
      finalReadiness.readiness.ok === initialReadiness.readiness.ok;
    const stableBoundary =
      JSON.stringify(finalReadiness.assessment) ===
        JSON.stringify(initialReadiness.assessment) &&
      finalReadiness.assessment.required === true &&
      finalReadiness.assessment.status === "ready" &&
      finalReadiness.assessment.publicOrigin === releaseUrl.origin &&
      finalReadiness.assessment.reason === null;
    const stable = stableDeployment && stableReadiness && stableBoundary;
    checks.push(
      check(
        "platform.deployment-stability",
        stable,
        "Deployment identity and release boundary remained stable throughout attestation.",
        {
          stableDeployment,
          stableReadiness,
          stableBoundary,
          deploymentIdPresent: Boolean(
            initialReadiness.deployment.deploymentId,
          ),
          revisionPresent: Boolean(initialReadiness.deployment.revision),
          productionEnvironment:
            initialReadiness.deployment.environment === "production",
        },
      ),
    );
  } catch {
    checks.push(
      check(
        "platform.deployment-stability",
        false,
        "The final deployment identity could not be attested.",
      ),
    );
  }
  return finish(initialReadiness.deployment);
};
