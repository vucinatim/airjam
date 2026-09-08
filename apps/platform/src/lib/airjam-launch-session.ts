export const AIR_JAM_LAUNCH_SESSION_COOKIE_NAME =
  "__Host-airjam-launch-session";
export const AIR_JAM_LAUNCH_SESSION_TTL_SECONDS = 24 * 60 * 60;

const LAUNCH_SESSION_TYPE = "airjam.launch_session.v1";
const LAUNCH_SESSION_SIGNING_DOMAIN =
  "airjam:launch-session-capability:signing-key:v1";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface AirJamLaunchSessionClaims {
  typ: typeof LAUNCH_SESSION_TYPE;
  abuseSessionId: string;
  iat: number;
  exp: number;
}

export interface CreateAirJamLaunchSessionInput {
  secret: string;
  now?: number;
  createId?: () => string;
}

export interface VerifyAirJamLaunchSessionResult {
  ok: boolean;
  claims?: AirJamLaunchSessionClaims;
  error?: string;
}

const getSubtleCrypto = (): SubtleCrypto => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("SubtleCrypto unavailable");
  }
  return subtle;
};

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

const fromBase64Url = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid base64url value");
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const deriveSigningKey = async (
  secret: string,
  usages: KeyUsage[],
): Promise<CryptoKey> => {
  const subtle = getSubtleCrypto();
  const rootKey = await subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derivedKey = await subtle.sign(
    "HMAC",
    rootKey,
    encoder.encode(LAUNCH_SESSION_SIGNING_DOMAIN),
  );
  return subtle.importKey(
    "raw",
    derivedKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
};

const isLaunchSessionClaims = (
  value: unknown,
): value is AirJamLaunchSessionClaims => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const claims = value as Record<string, unknown>;
  return (
    Object.keys(claims).length === 4 &&
    claims.typ === LAUNCH_SESSION_TYPE &&
    typeof claims.abuseSessionId === "string" &&
    UUID_PATTERN.test(claims.abuseSessionId) &&
    Number.isInteger(claims.iat) &&
    (claims.iat as number) > 0 &&
    Number.isInteger(claims.exp) &&
    (claims.exp as number) - (claims.iat as number) ===
      AIR_JAM_LAUNCH_SESSION_TTL_SECONDS
  );
};

export const createAirJamLaunchSession = async ({
  secret,
  now = Math.floor(Date.now() / 1_000),
  createId = () => globalThis.crypto.randomUUID(),
}: CreateAirJamLaunchSessionInput): Promise<{
  token: string;
  claims: AirJamLaunchSessionClaims;
}> => {
  if (!secret.trim()) {
    throw new Error("Launch-session signing secret is required");
  }

  const claims: AirJamLaunchSessionClaims = {
    typ: LAUNCH_SESSION_TYPE,
    abuseSessionId: createId(),
    iat: now,
    exp: now + AIR_JAM_LAUNCH_SESSION_TTL_SECONDS,
  };
  if (!isLaunchSessionClaims(claims)) {
    throw new Error("Invalid launch-session claims");
  }

  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signingKey = await deriveSigningKey(secret, ["sign"]);
  const signature = await getSubtleCrypto().sign(
    "HMAC",
    signingKey,
    encoder.encode(payload),
  );

  return {
    token: `${payload}.${toBase64Url(new Uint8Array(signature))}`,
    claims,
  };
};

export const verifyAirJamLaunchSession = async ({
  secret,
  token,
  now = Math.floor(Date.now() / 1_000),
}: {
  secret: string;
  token: string;
  now?: number;
}): Promise<VerifyAirJamLaunchSessionResult> => {
  if (!secret.trim()) {
    return { ok: false, error: "Launch-session signing is not configured" };
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return { ok: false, error: "Malformed launch session" };
  }
  const [payload, encodedSignature] = parts;

  try {
    const signingKey = await deriveSigningKey(secret, ["verify"]);
    const signatureValid = await getSubtleCrypto().verify(
      "HMAC",
      signingKey,
      toArrayBuffer(fromBase64Url(encodedSignature!)),
      encoder.encode(payload!),
    );
    if (!signatureValid) {
      return { ok: false, error: "Invalid launch-session signature" };
    }

    const claims = JSON.parse(
      decoder.decode(fromBase64Url(payload!)),
    ) as unknown;
    if (!isLaunchSessionClaims(claims)) {
      return { ok: false, error: "Invalid launch-session payload" };
    }
    if (claims.exp <= now) {
      return { ok: false, error: "Launch session expired" };
    }
    if (claims.iat > now + 60) {
      return { ok: false, error: "Launch session issued in the future" };
    }

    return { ok: true, claims };
  } catch {
    return { ok: false, error: "Malformed launch session" };
  }
};
