import { qaDraft } from './qa.mjs';
import { writeJsonAtomic } from './state-store.mjs';

const REFRESHABLE_CONTENT_TYPES = new Set(['news', 'guide']);

export function refreshableThumbnailDrafts(entries) {
  return (entries || [])
    .filter((entry) => entry?.draft && REFRESHABLE_CONTENT_TYPES.has(entry.draft.contentType))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function thumbnailRefreshSelection(entries) {
  return refreshableThumbnailDrafts(entries);
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
