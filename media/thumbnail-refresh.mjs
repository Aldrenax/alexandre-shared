import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ARTICLE_THUMBNAIL_POLICY } from './editorial.mjs';
import { qaDraft } from './qa.mjs';
import { writeJsonAtomic } from './state-store.mjs';

const REFRESHABLE_CONTENT_TYPES = new Set(['news', 'guide']);
const DEFAULT_RECOVERY_CUTOVER_AT = '2026-09-01T00:00:00.000Z';

export function thumbnailRefreshQueueId(draft) {
  return `${draft.mediaSlug}-${draft.contentType}-${draft.slug}`;
}

export function thumbnailAttemptLedgerKey(draft) {
  const stableId = String(draft?.candidateId || draft?.slug || '').trim();
  if (!draft?.mediaSlug || !draft?.contentType || !stableId) {
    throw new Error('Identité stable de miniature requise');
  }
  return `${draft.mediaSlug}:${draft.contentType}:${stableId}`;
}

export function thumbnailRefreshRetryDelayMinutes(attempts) {
  return Math.min(1_440, 15 * (2 ** Math.max(0, Number(attempts || 0) - 1)));
}

export function refreshableThumbnailDrafts(entries) {
  return (entries || [])
    .filter((entry) => entry?.draft && REFRESHABLE_CONTENT_TYPES.has(entry.draft.contentType))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function thumbnailRefreshSelection(entries) {
  return refreshableThumbnailDrafts(entries);
}

export function requestedThumbnailRefreshEntries(entries, requestedPath = null) {
  const selected = thumbnailRefreshSelection(entries);
  if (requestedPath === null || requestedPath === undefined) return selected;

  const normalizedRequestedPath = String(requestedPath).trim();
  if (!normalizedRequestedPath) {
    throw new Error('--draft requiert un chemin de brouillon');
  }
  const resolvedRequestedPath = resolve(normalizedRequestedPath);
  const matches = selected.filter(({ path }) => (
    typeof path === 'string' && resolve(path) === resolvedRequestedPath
  ));
  if (matches.length !== 1) {
    throw new Error('Brouillon miniature demandé introuvable dans les brouillons rafraîchissables');
  }
  return matches;
}

// Compatibilité d'import: la sélection n'est plus tronquée par une taille de
// lot arbitraire. La consommation est bornée au niveau des tentatives par le
// budget global et le coupe-circuit de génération.
export function representativeThumbnailBatch(entries) {
  return thumbnailRefreshSelection(entries);
}

export function thumbnailRefreshQueueDecision(payload, {
  maxTotalAttempts = 9,
  now = new Date(),
} = {}) {
  if (!payload) return { selected: true, reason: 'not-queued' };
  const attempts = Number(payload.attempts || 0);
  if (payload.status === 'quarantined' || attempts >= maxTotalAttempts) {
    return { selected: false, reason: 'quarantined' };
  }
  const nextAttemptAt = Date.parse(payload.nextAttemptAt || '');
  if (Number.isFinite(nextAttemptAt) && nextAttemptAt > now.getTime()) {
    return { selected: false, reason: 'retry-not-due' };
  }
  return { selected: true, reason: 'retry-due' };
}

export function thumbnailRefreshAttemptState(previousQueue = {}, newAttempts = [], {
  maxTotalAttempts = 9,
  reservedAttempts = 0,
} = {}) {
  const maximum = Math.max(1, Number(maxTotalAttempts) || 9);
  const previousAttempts = Math.max(0, Number(previousQueue.attempts || 0));
  const acceptedAttempts = (Array.isArray(newAttempts) ? newAttempts : [])
    .slice(0, Math.max(0, maximum - previousAttempts));
  const attempts = Math.min(
    maximum,
    Math.max(previousAttempts + acceptedAttempts.length, Number(reservedAttempts || 0)),
  );
  return {
    attempts,
    attemptLog: [...(previousQueue.attemptLog || []), ...acceptedAttempts],
    exhausted: attempts >= maximum,
    remainingAttempts: Math.max(0, maximum - attempts),
  };
}

export function dueThumbnailRefreshEntries(entries, {
  queueById = new Map(),
  scheduled = false,
  maxTotalAttempts = 9,
  now = new Date(),
} = {}) {
  return (entries || []).filter(({ draft }) => {
    const queued = queueById.get(thumbnailRefreshQueueId(draft));
    if (scheduled && !queued) return false;
    return thumbnailRefreshQueueDecision(queued, { maxTotalAttempts, now }).selected;
  });
}

export function thumbnailRefreshExitCode(results, { scheduled = false } = {}) {
  const outcomes = results || [];
  if (outcomes.some((result) => result?.status === 'skipped' && result?.reason === 'unknown-media')) return 1;
  if (scheduled) return 0;
  return outcomes.some((result) => ['retry-scheduled', 'quarantined'].includes(result?.status)) ? 1 : 0;
}

function failedThumbnailAttempts(draft) {
  return Math.max(
    Number(draft?.thumbnailGeneration?.attemptCount || 0),
    Number(draft?.thumbnailRefresh?.attempts || 0),
    Array.isArray(draft?.banner?.attempts) ? draft.banner.attempts.length : 0,
  );
}

/**
 * Répare uniquement les transitions explicitement interrompues du pipeline :
 * un brouillon miniature en échec sans file de reprise, ou un brouillon devenu
 * éligible pendant un refresh sans file de publication. Ce n'est pas un scan
 * historique : aucun brouillon ancien/générique n'est régénéré.
 */
export function reconcileThumbnailQueues(store, {
  maxTotalAttempts = 9,
  now = new Date(),
  publicationCutoverAt = process.env.MEDIA_ENGINE_PUBLICATION_QUEUE_CUTOVER_AT || DEFAULT_RECOVERY_CUTOVER_AT,
} = {}) {
  const cutoverAt = Date.parse(publicationCutoverAt || '');
  if (!Number.isFinite(cutoverAt)) {
    throw new Error('MEDIA_ENGINE_PUBLICATION_QUEUE_CUTOVER_AT invalide');
  }
  const refreshById = new Map(store.listQueueEntries('thumbnail-refresh')
    .map((entry) => [entry.payload?.queueId, entry.payload]));
  const publicationById = new Map(store.listQueueEntries('publication-ready')
    .map((entry) => [entry.payload?.queueId, entry.payload]));
  const recovered = [];

  for (const { path, draft } of refreshableThumbnailDrafts(store.listDrafts())) {
    const queueId = thumbnailRefreshQueueId(draft);
    const published = store.hasEvent(`published:${draft.mediaSlug}:${draft.contentType}:${draft.slug}`)
      || [
        join(store.stateDir, 'wordpress-publication-receipts', draft.mediaSlug, `${draft.slug}.json`),
        join(store.stateDir, 'publication-receipts', draft.mediaSlug, `${draft.slug}.json`),
      ].some((receiptPath) => existsSync(receiptPath));
    const eligible = draft?.qa?.passed === true
      && draft?.publicationEligibility?.status === 'eligible';
    const currentPolicy = draft?.banner?.qa?.policy === ARTICLE_THUMBNAIL_POLICY;
    const explicitPublicationTransition = currentPolicy && (
      draft?.thumbnailGeneration?.status === 'passed'
      || draft?.thumbnailRefresh?.status === 'qa-passed-requeued'
      || refreshById.has(queueId)
    );
    const transitionAt = Date.parse(
      draft?.thumbnailRefresh?.refreshedAt || draft?.generatedAt || '',
    );
    const afterCutover = Number.isFinite(transitionAt) && transitionAt >= cutoverAt;

    if (eligible && explicitPublicationTransition && afterCutover && !published && !publicationById.has(queueId)) {
      const publicationPath = store.enqueuePublicationReady(path, draft, { now });
      if (publicationPath) {
        publicationById.set(queueId, { queueId, draftPath: path });
        recovered.push({ queueId, action: 'publication-ready-restored', path: publicationPath });
      }
    }

    // Une entrée de refresh encore présente après que le draft est devenu
    // publiable signifie que le crash a eu lieu après l'écriture du draft.
    // La retirer seulement après restauration de publication-ready rend la
    // transition idempotente et sûre au prochain timer.
    if (eligible && explicitPublicationTransition && (published || publicationById.has(queueId)) && refreshById.has(queueId)) {
      store.removeQueueEntry('thumbnail-refresh', queueId);
      refreshById.delete(queueId);
      recovered.push({ queueId, action: 'thumbnail-refresh-completed' });
      continue;
    }

    const retryableFailure = currentPolicy
      && afterCutover
      && draft?.thumbnailGeneration?.retryOwner === 'thumbnail-refresh'
      && draft?.banner?.qa?.passed !== true
      && ['qa-failed', 'deferred'].includes(draft?.thumbnailGeneration?.status);
    if (!retryableFailure || refreshById.has(queueId)) continue;
    const attempts = failedThumbnailAttempts(draft);
    const exhausted = attempts >= maxTotalAttempts;
    const circuitRetryAt = Date.parse(draft?.thumbnailGeneration?.nextRetryAt || '');
    const backoffAt = now.getTime() + thumbnailRefreshRetryDelayMinutes(attempts) * 60_000;
    const nextAttemptAt = exhausted
      ? null
      : new Date(Math.max(backoffAt, Number.isFinite(circuitRetryAt) ? circuitRetryAt : 0)).toISOString();
    const payload = {
      version: 1,
      queueId,
      mediaSlug: draft.mediaSlug,
      contentType: draft.contentType,
      slug: draft.slug,
      title: draft.title,
      draftPath: path,
      status: exhausted ? 'quarantined' : 'retry-scheduled',
      queuedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      attempts,
      attemptLog: draft.banner?.attempts || [],
      nextAttemptAt,
      qa: draft.banner?.qa || null,
      circuitReason: draft.thumbnailGeneration?.circuitReason || null,
      recoveredFromDraft: true,
    };
    store.enqueue('thumbnail-refresh', queueId, payload);
    refreshById.set(queueId, payload);
    recovered.push({ queueId, action: 'thumbnail-refresh-restored', status: payload.status });
  }
  return recovered;
}

export function reconciledThumbnailDraft({
  originalDraft,
  banner,
  media,
  candidate,
  alreadyPublished = false,
  refreshedAt = new Date().toISOString(),
  backupPath = null,
  attempts = 0,
  evaluateQa = qaDraft,
}) {
  const provisional = {
    ...originalDraft,
    banner,
    thumbnailRefresh: {
      ...(originalDraft.thumbnailRefresh || {}),
      refreshedAt,
      backupPath,
      policy: banner?.qa?.policy || null,
      status: 'qa-passed',
      attempts,
      publicAssetUpdated: false,
      scope: alreadyPublished ? 'local-draft-only-published-asset-unchanged' : 'publication-reconciliation',
    },
  };
  const qa = evaluateQa(provisional, media, { candidate, requireBanner: true, now: new Date(refreshedAt) });
  const candidateQualified = candidate?.status === 'qualified';
  const publicationReady = qa.passed && candidateQualified && !alreadyPublished;
  let status = 'blocked';
  let reason = 'thumbnail-refresh-qa-failed';
  if (alreadyPublished) {
    status = 'published';
    reason = 'public-asset-unchanged';
  } else if (!candidateQualified) {
    reason = 'thumbnail-refresh-candidate-unavailable';
  } else if (publicationReady) {
    status = 'eligible';
    reason = null;
  }
  return {
    draft: {
      ...provisional,
      qa,
      publicationEligibility: {
        status,
        checkedAt: refreshedAt,
        reason,
      },
      thumbnailRefresh: {
        ...provisional.thumbnailRefresh,
        status: publicationReady ? 'qa-passed-requeued' : provisional.thumbnailRefresh.status,
      },
    },
    publicationReady,
  };
}

export function persistReconciledThumbnail({ store, draftPath, draft, publicationReady }) {
  const queueId = `${draft.mediaSlug}-${draft.contentType}-${draft.slug}`;
  writeJsonAtomic(draftPath, draft);
  if (publicationReady) {
    return store.enqueuePublicationReady(draftPath, draft);
  }
  store.removeQueueEntry('publication-ready', queueId);
  return null;
}
