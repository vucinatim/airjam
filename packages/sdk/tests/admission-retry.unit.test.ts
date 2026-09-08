import { describe, expect, it } from "vitest";
import { ErrorCode } from "../src/protocol";
import { resolveAdmissionRetry } from "../src/runtime/admission-retry";

describe("admission retry policy", () => {
  it("uses retry-after as a floor and adds bounded positive jitter", () => {
    expect(
      resolveAdmissionRetry(
        {
          code: ErrorCode.SERVICE_UNAVAILABLE,
          retryAfterSeconds: 2,
        },
        0,
        () => 0.5,
      ),
    ).toEqual({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      retryAfterSeconds: 2,
      delayMs: 2_200,
    });
  });

  it("retries only explicit bounded service-unavailable denials", () => {
    expect(
      resolveAdmissionRetry(
        { code: ErrorCode.ROOM_FULL, retryAfterSeconds: 1 },
        0,
      ),
    ).toBeNull();
    expect(
      resolveAdmissionRetry({ code: ErrorCode.SERVICE_UNAVAILABLE }, 0),
    ).toBeNull();
    expect(
      resolveAdmissionRetry(
        {
          code: ErrorCode.SERVICE_UNAVAILABLE,
          retryAfterSeconds: 120,
        },
        0,
        () => 0,
      ),
    ).toMatchObject({ retryAfterSeconds: 120, delayMs: 120_000 });
    expect(
      resolveAdmissionRetry(
        {
          code: ErrorCode.SERVICE_UNAVAILABLE,
          retryAfterSeconds: 301,
        },
        0,
      ),
    ).toBeNull();
  });

  it("stops after three retries", () => {
    expect(
      resolveAdmissionRetry(
        {
          code: ErrorCode.SERVICE_UNAVAILABLE,
          retryAfterSeconds: 1,
        },
        3,
      ),
    ).toBeNull();
  });
});
