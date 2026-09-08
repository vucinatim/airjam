import { ErrorCode } from "../protocol/errors";

const MAX_ADMISSION_RETRIES = 3;
// Production lane controls intentionally support multi-minute pauses. Keep the
// automatic wait bounded, but do not turn an ordinary 60-300 second operator
// retry window into a reload-only state.
const MAX_RETRY_AFTER_SECONDS = 5 * 60;
const MIN_ADMISSION_RETRY_DELAY_MS = 250;
const MAX_RETRY_JITTER_MS = 1_000;
const RETRY_JITTER_RATIO = 0.2;

interface AdmissionDenial {
  code?: ErrorCode | string;
  retryAfterSeconds?: number;
}

export interface AdmissionRetryDecision {
  code: ErrorCode.SERVICE_UNAVAILABLE;
  retryAfterSeconds: number;
  delayMs: number;
}

/**
 * Converts an explicit admission denial into one bounded client retry.
 * The server's delay is a floor; positive jitter spreads reconnecting clients
 * without retrying earlier than the authoritative retry-after value.
 */
export const resolveAdmissionRetry = (
  denial: AdmissionDenial,
  completedRetries: number,
  random: () => number = Math.random,
): AdmissionRetryDecision | null => {
  if (
    denial.code !== ErrorCode.SERVICE_UNAVAILABLE ||
    completedRetries >= MAX_ADMISSION_RETRIES ||
    denial.retryAfterSeconds === undefined ||
    !Number.isFinite(denial.retryAfterSeconds) ||
    denial.retryAfterSeconds <= 0 ||
    denial.retryAfterSeconds > MAX_RETRY_AFTER_SECONDS
  ) {
    return null;
  }

  const retryAfterMs = Math.max(
    Math.ceil(denial.retryAfterSeconds * 1_000),
    MIN_ADMISSION_RETRY_DELAY_MS,
  );
  const jitterWindowMs = Math.min(
    Math.ceil(retryAfterMs * RETRY_JITTER_RATIO),
    MAX_RETRY_JITTER_MS,
  );
  const randomSample = random();
  const boundedRandom = Number.isFinite(randomSample)
    ? Math.max(0, Math.min(1, randomSample))
    : 0.5;

  return {
    code: ErrorCode.SERVICE_UNAVAILABLE,
    retryAfterSeconds: denial.retryAfterSeconds,
    delayMs: retryAfterMs + Math.floor(jitterWindowMs * boundedRandom),
  };
};
