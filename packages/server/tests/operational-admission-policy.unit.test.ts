import {
  decideOperationalAdmissionPolicy,
  type OperationalLaneControlSnapshot,
} from "@air-jam/database-contract";
import { describe, expect, it } from "vitest";

const control = (
  mode: OperationalLaneControlSnapshot["mode"],
): OperationalLaneControlSnapshot => ({
  lane: "realtime_controller_admission",
  mode,
  reason: null,
  retryAfterSeconds: null,
  revision: 1,
  updatedBy: "test",
  updatedAt: "2026-09-08T00:00:00.000Z",
});

describe("shared operational admission policy", () => {
  it("reports enforced authority truthfully on every restricted denial path", () => {
    expect(
      decideOperationalAdmissionPolicy({
        lane: "realtime_controller_admission",
        control: control("restricted"),
        budget: { evidenceStatus: "fresh", state: "normal" },
        quota: {
          authorityAvailable: false,
          current: null,
          limit: 10,
          requestedAmount: 1,
        },
      }),
    ).toMatchObject({
      outcome: "denied",
      reason: "control_unavailable",
      quotaEnforced: true,
    });

    expect(
      decideOperationalAdmissionPolicy({
        lane: "realtime_controller_admission",
        control: control("normal"),
        budget: { evidenceStatus: "fresh", state: "ceiling" },
      }),
    ).toMatchObject({
      outcome: "denied",
      reason: "budget_protection",
      quotaEnforced: true,
    });
  });
});
