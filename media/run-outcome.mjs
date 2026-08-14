export const EDITORIAL_CANDIDATE_DEFERRAL_REASONS = new Set([
  'corroboration-accessible-insuffisante',
  'preuve-source-inaccessible',
  'source-officielle-inaccessible',
]);

export function classifyRunOutcome(command, result, { mediaSlug = null } = {}) {
  const failedEntries = command === 'video' && Array.isArray(result)
    ? result.filter((entry) => entry?.failed)
    : [];
  const scheduledRetries = command === 'video' && Array.isArray(result)
    ? result.filter((entry) => entry?.retryScheduled)
    : [];
  const newsFailures = command === 'run' && Array.isArray(result?.attempts)
    ? result.attempts.filter((entry) => entry?.status === 'retryable-failure')
    : [];
  const candidateDeferrals = newsFailures
    .filter((entry) => EDITORIAL_CANDIDATE_DEFERRAL_REASONS.has(entry?.reason));
  const newsRetries = newsFailures
    .filter((entry) => !EDITORIAL_CANDIDATE_DEFERRAL_REASONS.has(entry?.reason));
  const newsQaFailures = command === 'run' && Array.isArray(result?.attempts)
    ? result.attempts.filter((entry) => entry?.status === 'qa-failed')
    : [];
  const status = failedEntries.length || newsQaFailures.length
    ? 'degraded'
    : scheduledRetries.length || newsRetries.length
      ? 'warning'
      : 'success';

  return {
    failed: failedEntries.length > 0,
    receipt: {
      status,
      mediaSlug,
      ...(failedEntries.length ? {
        failures: failedEntries.map((entry) => ({ mediaSlug: entry.mediaSlug, videoId: entry.videoId, error: entry.error || entry.reason })),
      } : {}),
      ...(scheduledRetries.length ? {
        scheduledRetries: scheduledRetries.map((entry) => ({ mediaSlug: entry.mediaSlug, videoId: entry.videoId, reason: entry.error || entry.reason })),
      } : {}),
      ...(candidateDeferrals.length ? {
        candidateDeferrals: candidateDeferrals.map((entry) => ({ mediaSlug: entry.mediaSlug, candidateId: entry.candidateId, reason: entry.reason })),
      } : {}),
      ...(newsRetries.length ? {
        candidateRetries: newsRetries.map((entry) => ({ mediaSlug: entry.mediaSlug, candidateId: entry.candidateId, reason: entry.reason })),
      } : {}),
      ...(newsQaFailures.length ? {
        qaFailures: newsQaFailures.map((entry) => ({ mediaSlug: entry.mediaSlug, candidateId: entry.candidateId, reason: entry.reason })),
      } : {}),
    },
  };
}
