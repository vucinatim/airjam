import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
const MIN_TTL_SECONDS = 5 * 60;
const CLOCK_SKEW_SECONDS = 30;

const requiredText = (value, label) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
};

const encodeJson = (value) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const parseJsonSegment = (segment, label) => {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new Error(`R2 temporary credential ${label} is invalid.`);
  }
};

const equalSecret = (left, right) => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
};

const resolveEndpointIdentity = (endpoint) => {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("R2 endpoint must be an absolute HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.pathname !== "/") {
    throw new Error("R2 endpoint must be an origin-only HTTPS URL.");
  }
  return { endpoint: url.origin, audience: url.host };
};

const normalizeTtlSeconds = (value) => {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_TTL_SECONDS ||
    value > MAX_TTL_SECONDS
  ) {
    throw new Error(
      `R2 temporary credential TTL must be between ${MIN_TTL_SECONDS} and ${MAX_TTL_SECONDS} seconds.`,
    );
  }
  return value;
};

export const createCloudflareR2TemporaryCredentials = ({
  endpoint,
  accountId,
  parentAccessKeyId,
  parentSecretAccessKey,
  bucket,
  ttlSeconds = 24 * 60 * 60,
  now = Date.now(),
}) => {
  const endpointIdentity = resolveEndpointIdentity(endpoint);
  const normalizedAccountId = requiredText(accountId, "R2 account id");
  const normalizedAccessKeyId = requiredText(
    parentAccessKeyId,
    "R2 parent access key id",
  );
  const normalizedSecretAccessKey = requiredText(
    parentSecretAccessKey,
    "R2 parent secret access key",
  );
  const normalizedBucket = requiredText(bucket, "R2 bucket");
  const normalizedTtlSeconds = normalizeTtlSeconds(ttlSeconds);
  const issuedAt = Math.floor(now / 1_000);
  const expiresAt = issuedAt + normalizedTtlSeconds;
  const header = encodeJson({ alg: "HS256", typ: "JWT" });
  const payload = encodeJson({
    bucket: normalizedBucket,
    scope: "object-read-write",
    sub: normalizedAccountId,
    iss: normalizedAccessKeyId,
    aud: endpointIdentity.audience,
    iat: issuedAt,
    exp: expiresAt,
  });
  const unsignedToken = `${header}.${payload}`;
  const signature = createHmac("sha256", normalizedSecretAccessKey)
    .update(unsignedToken)
    .digest("base64url");
  const jwt = `${unsignedToken}.${signature}`;

  return {
    accessKeyId: normalizedAccessKeyId,
    secretAccessKey: createHash("sha256").update(jwt).digest("hex"),
    sessionToken: Buffer.from(`jwt/${jwt}`, "utf8").toString("base64"),
    bucket: normalizedBucket,
    scope: "object-read-write",
    issuedAt: new Date(issuedAt * 1_000).toISOString(),
    expiresAt: new Date(expiresAt * 1_000).toISOString(),
    ttlSeconds: normalizedTtlSeconds,
  };
};

export const verifyCloudflareR2TemporaryCredentials = ({
  endpoint,
  accountId,
  parentAccessKeyId,
  parentSecretAccessKey,
  bucket,
  accessKeyId,
  secretAccessKey,
  sessionToken,
  now = Date.now(),
}) => {
  const endpointIdentity = resolveEndpointIdentity(endpoint);
  const normalizedAccountId = requiredText(accountId, "R2 account id");
  const normalizedParentAccessKeyId = requiredText(
    parentAccessKeyId,
    "R2 parent access key id",
  );
  const normalizedParentSecretAccessKey = requiredText(
    parentSecretAccessKey,
    "R2 parent secret access key",
  );
  const normalizedBucket = requiredText(bucket, "R2 bucket");
  const normalizedAccessKeyId = requiredText(accessKeyId, "R2 access key id");
  const normalizedSecretAccessKey = requiredText(
    secretAccessKey,
    "R2 secret access key",
  );
  const normalizedSessionToken = requiredText(sessionToken, "R2 session token");

  if (normalizedAccessKeyId !== normalizedParentAccessKeyId) {
    throw new Error(
      "R2 temporary credential access key does not match its parent authority.",
    );
  }

  let sessionPayload;
  try {
    sessionPayload = Buffer.from(normalizedSessionToken, "base64").toString(
      "utf8",
    );
  } catch {
    throw new Error("R2 session token is not valid base64.");
  }
  if (!sessionPayload.startsWith("jwt/")) {
    throw new Error("R2 session token does not contain a signed JWT.");
  }
  const jwt = sessionPayload.slice(4);
  const segments = jwt.split(".");
  if (segments.length !== 3 || segments.some((segment) => !segment)) {
    throw new Error("R2 session token JWT is malformed.");
  }
  const [headerSegment, payloadSegment, signature] = segments;
  const header = parseJsonSegment(headerSegment, "header");
  const claims = parseJsonSegment(payloadSegment, "claims");

  if (header?.alg !== "HS256" || header?.typ !== "JWT") {
    throw new Error("R2 session token uses an unsupported JWT header.");
  }
  const expectedSignature = createHmac(
    "sha256",
    normalizedParentSecretAccessKey,
  )
    .update(`${headerSegment}.${payloadSegment}`)
    .digest("base64url");
  if (!equalSecret(signature, expectedSignature)) {
    throw new Error("R2 session token signature is invalid.");
  }
  const expectedSecretAccessKey = createHash("sha256")
    .update(jwt)
    .digest("hex");
  if (!equalSecret(normalizedSecretAccessKey, expectedSecretAccessKey)) {
    throw new Error(
      "R2 temporary secret access key is not bound to its session token.",
    );
  }
  if (
    claims?.bucket !== normalizedBucket ||
    claims?.sub !== normalizedAccountId ||
    claims?.iss !== normalizedParentAccessKeyId ||
    claims?.aud !== endpointIdentity.audience
  ) {
    throw new Error(
      "R2 temporary credential identity or bucket scope does not match staging.",
    );
  }
  if (claims?.scope !== "object-read-write") {
    throw new Error(
      "R2 temporary credential must use object-read-write staging-bucket authority.",
    );
  }
  if (claims.actions !== undefined || claims.paths !== undefined) {
    throw new Error(
      "R2 staging credentials must cover the complete isolated bucket lifecycle.",
    );
  }
  if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) {
    throw new Error("R2 temporary credential timestamps are invalid.");
  }
  normalizeTtlSeconds(claims.exp - claims.iat);
  const nowSeconds = Math.floor(now / 1_000);
  if (claims.iat > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new Error("R2 temporary credential is not active yet.");
  }
  if (claims.exp <= nowSeconds) {
    throw new Error("R2 temporary credential has expired.");
  }

  return {
    bucket: normalizedBucket,
    scope: claims.scope,
    issuedAt: new Date(claims.iat * 1_000).toISOString(),
    expiresAt: new Date(claims.exp * 1_000).toISOString(),
    ttlSeconds: claims.exp - claims.iat,
  };
};
