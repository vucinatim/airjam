export const SUPERSEDED_RELEASE_RETENTION_DAYS = 180;
export const SUPERSEDED_RELEASE_WARNING_DAYS = 7;

export const SUPERSEDED_RELEASE_RETENTION_MS =
  SUPERSEDED_RELEASE_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
export const SUPERSEDED_RELEASE_WARNING_MS =
  SUPERSEDED_RELEASE_WARNING_DAYS * 24 * 60 * 60 * 1_000;

export type ReleaseStorageRetentionClock = Readonly<{
  inactiveAt: Date | null;
  warnedAt: Date | null;
  eligibleAt: Date | null;
  cleanupStartedAt: Date | null;
  deletedAt: Date | null;
}>;

export const resolveReleaseStorageRetentionState = ({
  clock,
  now = new Date(),
}: {
  clock: ReleaseStorageRetentionClock;
  now?: Date;
}): PlatformMachineReleaseStorageRetentionState => {
  if (clock.deletedAt) return "tombstoned";
  if (clock.cleanupStartedAt) return "deleting";
  if (clock.eligibleAt && clock.eligibleAt.getTime() <= now.getTime()) {
    return "reclaimable";
  }
  if (clock.warnedAt) return "warned";
  return "active";
};

export const calculateSupersededReleaseWarningAt = (inactiveAt: Date) =>
  new Date(
    inactiveAt.getTime() +
      SUPERSEDED_RELEASE_RETENTION_MS -
      SUPERSEDED_RELEASE_WARNING_MS,
  );

export const calculateSupersededReleaseEligibleAt = ({
  inactiveAt,
  warnedAt,
}: {
  inactiveAt: Date;
  warnedAt: Date;
}) =>
  new Date(
    Math.max(
      inactiveAt.getTime() + SUPERSEDED_RELEASE_RETENTION_MS,
      warnedAt.getTime() + SUPERSEDED_RELEASE_WARNING_MS,
    ),
  );
import type { PlatformMachineReleaseStorageRetentionState } from "@air-jam/sdk/platform-machine";
