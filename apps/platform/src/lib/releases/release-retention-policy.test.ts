import { describe, expect, it } from "vitest";
import {
  calculateSupersededReleaseEligibleAt,
  calculateSupersededReleaseWarningAt,
  resolveReleaseStorageRetentionState,
} from "./release-retention-policy";

describe("release retention policy", () => {
  const inactiveAt = new Date("2026-01-01T00:00:00.000Z");

  it("opens the warning window seven days before 180-day eligibility", () => {
    const warnedAt = calculateSupersededReleaseWarningAt(inactiveAt);
    const eligibleAt = calculateSupersededReleaseEligibleAt({
      inactiveAt,
      warnedAt,
    });

    expect(warnedAt.toISOString()).toBe("2026-06-23T00:00:00.000Z");
    expect(eligibleAt.toISOString()).toBe("2026-06-30T00:00:00.000Z");
  });

  it("never shortens the warning window when warning delivery is late", () => {
    const warnedAt = new Date("2026-07-10T00:00:00.000Z");
    expect(
      calculateSupersededReleaseEligibleAt({
        inactiveAt,
        warnedAt,
      }).toISOString(),
    ).toBe("2026-07-17T00:00:00.000Z");
  });

  it("projects the durable lifecycle without overriding deletion authority", () => {
    const warnedAt = new Date("2026-06-23T00:00:00.000Z");
    const eligibleAt = new Date("2026-06-30T00:00:00.000Z");
    const clock = {
      inactiveAt,
      warnedAt,
      eligibleAt,
      cleanupStartedAt: null,
      deletedAt: null,
    };

    expect(
      resolveReleaseStorageRetentionState({
        clock,
        now: new Date("2026-06-29T23:59:59.999Z"),
      }),
    ).toBe("warned");
    expect(
      resolveReleaseStorageRetentionState({
        clock,
        now: new Date("2026-06-30T00:00:00.000Z"),
      }),
    ).toBe("reclaimable");
    expect(
      resolveReleaseStorageRetentionState({
        clock: { ...clock, cleanupStartedAt: eligibleAt },
      }),
    ).toBe("deleting");
    expect(
      resolveReleaseStorageRetentionState({
        clock: {
          ...clock,
          cleanupStartedAt: eligibleAt,
          deletedAt: new Date("2026-06-30T00:01:00.000Z"),
        },
      }),
    ).toBe("tombstoned");
  });
});
