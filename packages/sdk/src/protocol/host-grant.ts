import { z } from "zod";
import { hostSessionKindSchema } from "./host";

export const hostGrantScopeSchema = z.literal("host:bootstrap");
export const hostGrantAudienceSchema = z.literal("airjam:realtime");
export const hostGrantIntentSchema = z.enum(["create_room", "system_register"]);

export const hostGrantClaimsSchema = z.object({
  typ: z.literal("airjam.host_grant.v3"),
  jti: z.string().uuid(),
  aud: hostGrantAudienceSchema,
  appId: z.string().min(1),
  gameId: z.string().min(1),
  creatorId: z.string().min(1),
  exp: z.number().int().positive(),
  iat: z.number().int().positive(),
  scopes: z.array(hostGrantScopeSchema).min(1).default(["host:bootstrap"]),
  origins: z.array(z.string().url()).min(1),
  sessionKind: hostSessionKindSchema,
  intent: hostGrantIntentSchema,
  abuseSessionId: z.string().uuid(),
});

export type HostGrantClaims = z.infer<typeof hostGrantClaimsSchema>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const getSubtleCrypto = (): SubtleCrypto => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("SubtleCrypto unavailable");
  }
  return subtle;
};

const getBtoa = (): ((value: string) => string) => {
  if (typeof globalThis.btoa === "function") {
    return globalThis.btoa.bind(globalThis);
  }
  throw new Error("Base64 encoding unavailable");
};

const getAtob = (): ((value: string) => string) => {
  if (typeof globalThis.atob === "function") {
    return globalThis.atob.bind(globalThis);
  }
  throw new Error("Base64 decoding unavailable");
};

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return getBtoa()(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

const fromBase64Url = (value: string): Uint8Array => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );

  const binary = getAtob()(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

const encodeJson = (value: unknown): string =>
  toBase64Url(encoder.encode(JSON.stringify(value)));

const decodeJson = <T>(value: string): T =>
  JSON.parse(decoder.decode(fromBase64Url(value))) as T;

const signHmacSha256 = async (
  secret: string,
  data: string,
): Promise<Uint8Array> => {
  const subtle = getSubtleCrypto();
  const key = await subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await subtle.sign("HMAC", key, encoder.encode(data));
  return new Uint8Array(signature);
};

const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a[i]! ^ b[i]!;
  }
  return result === 0;
};

export interface CreateHostGrantInput {
  secret: string;
  claims: Omit<HostGrantClaims, "typ"> & Partial<Pick<HostGrantClaims, "typ">>;
}

export const createHostGrant = async ({
  secret,
  claims,
}: CreateHostGrantInput): Promise<string> => {
  const normalizedClaims = hostGrantClaimsSchema.parse({
    typ: "airjam.host_grant.v3",
    ...claims,
  });

  const header = encodeJson({
    alg: "HS256",
    typ: "AIRJAM_HOST_GRANT",
  });
  const payload = encodeJson(normalizedClaims);
  const signature = toBase64Url(
    await signHmacSha256(secret, `${header}.${payload}`),
  );

  return `${header}.${payload}.${signature}`;
};

export interface VerifyHostGrantInput {
  secret: string;
  token: string;
  now?: number;
}

export interface VerifyHostGrantResult {
  ok: boolean;
  claims?: HostGrantClaims;
  error?: string;
}

export const verifyHostGrant = async ({
  secret,
  token,
  now = Math.floor(Date.now() / 1000),
}: VerifyHostGrantInput): Promise<VerifyHostGrantResult> => {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, error: "Malformed host grant" };
  }

  const [header, payload, signature] = parts;

  try {
    const parsedHeader = decodeJson<{ alg?: string; typ?: string }>(header!);
    if (
      parsedHeader.alg !== "HS256" ||
      parsedHeader.typ !== "AIRJAM_HOST_GRANT"
    ) {
      return { ok: false, error: "Unsupported host grant header" };
    }

    const expectedSignature = await signHmacSha256(
      secret,
      `${header}.${payload}`,
    );
    if (!timingSafeEqual(expectedSignature, fromBase64Url(signature!))) {
      return { ok: false, error: "Invalid host grant signature" };
    }

    const parsedClaims = hostGrantClaimsSchema.safeParse(
      decodeJson<unknown>(payload!),
    );
    if (!parsedClaims.success) {
      return { ok: false, error: "Invalid host grant payload" };
    }

    if (parsedClaims.data.exp <= now) {
      return { ok: false, error: "Host grant expired" };
    }

    if (
      parsedClaims.data.iat > now + 30 ||
      parsedClaims.data.exp <= parsedClaims.data.iat ||
      parsedClaims.data.exp - parsedClaims.data.iat > 120
    ) {
      return { ok: false, error: "Invalid host grant lifetime" };
    }

    if (!parsedClaims.data.scopes.includes("host:bootstrap")) {
      return { ok: false, error: "Host grant missing bootstrap scope" };
    }

    return {
      ok: true,
      claims: parsedClaims.data,
    };
  } catch {
    return { ok: false, error: "Malformed host grant" };
  }
};
