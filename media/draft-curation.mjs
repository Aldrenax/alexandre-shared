import { findDraftConflict, findInternalLinkConflict } from './candidates.mjs';
import { writeJsonAtomic } from './state-store.mjs';

function timestamp(draft = {}) {
  return Date.parse(draft.generatedAt || draft.scheduledPublishAt || '') || 0;
}

function candidateFromDraft(draft) {
  return {
    title: draft.title || '',
    primaryUrl: draft.primaryUrl || null,
    sourceUrls: draft.sourceUrls || [],
  };
}

/**
 * Classe les brouillons historiques sans les supprimer. Les doublons restent
 * sur disque avec un statut explicite, ce qui permet une restauration manuelle
 * et empêche tout passage accidentel dans le worker de publication.
 */
export function curateDraftQueue(entries = [], internalLinks = {}, { now = new Date() } = {}) {
  const retained = [];
  const decisions = [];
  const sorted = [...entries].sort((left, right) => timestamp(right.draft) - timestamp(left.draft));
  for (const entry of sorted) {
    const draft = entry.draft || {};
    const base = { path: entry.path, mediaSlug: draft.mediaSlug, contentType: draft.contentType, title: draft.title };
    if (!draft?.qa?.passed) {
      decisions.push({ ...base, status: 'quarantined', reason: 'qa-failed' });
      continue;
    }
    const conflict = findDraftConflict(candidateFromDraft(draft), retained.map((item) => ({ ...item.draft, draftPath: item.path })), {
      mediaSlug: draft.mediaSlug,
      contentType: draft.contentType,
    });
    if (conflict) {
      decisions.push({ ...base, status: 'quarantined', reason: `duplicate-${conflict.reason}`, duplicateOf: conflict.draft.draftPath || null });
      continue;
    }
    const liveConflict = findInternalLinkConflict(candidateFromDraft(draft), internalLinks[draft.mediaSlug] || []);
    if (liveConflict) {
      decisions.push({ ...base, status: 'quarantined', reason: 'already-published-or-similar', duplicateOf: liveConflict.path || null });
      continue;
    }
    retained.push(entry);
    decisions.push({
      ...base,
      status: draft.publicationEligibility?.status || 'review-required',
      reason: draft.publicationEligibility?.reason || 'legacy-shadow-draft',
    });
  }
  return {
    checkedAt: now.toISOString(),
    total: entries.length,
    retained: decisions.filter((decision) => decision.status !== 'quarantined').length,
    quarantined: decisions.filter((decision) => decision.status === 'quarantined').length,
    decisions,
  };
}

export function applyDraftCuration(entries = [], report, { now = new Date() } = {}) {
  const byPath = new Map(report.decisions.map((decision) => [decision.path, decision]));
  for (const entry of entries) {
    const decision = byPath.get(entry.path);
    if (!decision) continue;
    const draft = {
      ...entry.draft,
      publicationEligibility: {
        status: decision.status,
        reason: decision.reason,
        duplicateOf: decision.duplicateOf || null,
        checkedAt: now.toISOString(),
      },
    };
    writeJsonAtomic(entry.path, draft);
  }
  return report;
}
