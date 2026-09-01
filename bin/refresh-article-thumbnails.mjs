#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MediaEngine, materializeBanner } from '../media/engine.mjs';
import { ARTICLE_THUMBNAIL_POLICY } from '../media/editorial.mjs';
import { loadEnvironmentFile } from '../media/environment.mjs';
import { mediaBySlug } from '../media/registry.mjs';
import { readJson, writeJsonAtomic } from '../media/state-store.mjs';
import {
  generateThumbnailWithQa,
  promoteThumbnailCandidate,
  ThumbnailGenerationBudget,
} from '../media/thumbnail-generation.mjs';
import {
  dueThumbnailRefreshEntries,
  persistReconciledThumbnail,
  reconciledThumbnailDraft,
  thumbnailAttemptLedgerKey,
  thumbnailRefreshAttemptState,
  thumbnailRefreshExitCode,
  thumbnailRefreshQueueId,
  thumbnailRefreshRetryDelayMinutes,
  requestedThumbnailRefreshEntries,
  reconcileThumbnailQueues,
} from '../media/thumbnail-refresh.mjs';
import { candidateForDraft } from '../media/source-policy.mjs';

loadEnvironmentFile(process.env.MEDIA_ENGINE_ENV_FILE || '/etc/alexandre-media-engine/media-engine.env');

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function failureEvent(engine, draft, draftPath, qa, attempts, status) {
  const eventId = `thumbnail-qa-failed-${draft.mediaSlug}-${draft.contentType}-${draft.slug}`;
  return engine.store.enqueue('events', eventId, {
    version: 1,
    type: 'editorial.draft.qa-failed',
    scope: 'thumbnail-refresh',
    createdAt: new Date().toISOString(),
    mediaSlug: draft.mediaSlug,
    candidateId: draft.candidateId || null,
    contentType: draft.contentType,
    draftPath,
    title: draft.title,
    status,
    attempts,
    qa,
  });
}

const apply = process.argv.includes('--apply');
const scheduled = process.argv.includes('--scheduled');
const newsOnly = process.argv.includes('--news-only');
const mediaSlug = argument('--media');
const draftSelectorPresent = process.argv.includes('--draft');
const requestedDraftPath = argument('--draft');
if (draftSelectorPresent && (!requestedDraftPath || requestedDraftPath.startsWith('--'))) {
  throw new Error('--draft requiert un chemin de brouillon');
}
if (process.argv.includes('--limit')) {
  throw new Error('--limit a été supprimé: tous les contenus sont sélectionnés; utilisez --budget pour borner les tentatives globales');
}

const engine = new MediaEngine();
let refreshLease = null;
if (apply) {
  engine.store.initialize();
  refreshLease = engine.store.acquireLease('thumbnail-refresh-cycle', { ttlMs: 13 * 60 * 60_000 });
  if (!refreshLease) {
    console.log(JSON.stringify({
      dryRun: false,
      scheduled,
      skipped: true,
      reason: 'thumbnail-refresh-lease-active',
    }, null, 2));
    process.exit(0);
  }
}

try {
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const maxAttemptsPerRun = positiveInteger(
  argument('--max-attempts-per-thumbnail', process.env.MEDIA_ENGINE_THUMBNAIL_MAX_ATTEMPTS_PER_ITEM),
  3,
);
const maxTotalAttempts = positiveInteger(process.env.MEDIA_ENGINE_THUMBNAIL_MAX_TOTAL_ATTEMPTS_PER_ITEM, 9);
const budget = ThumbnailGenerationBudget.fromEnvironment({
  ...process.env,
  MEDIA_ENGINE_THUMBNAIL_GLOBAL_ATTEMPT_BUDGET: argument('--budget', process.env.MEDIA_ENGINE_THUMBNAIL_GLOBAL_ATTEMPT_BUDGET),
}, { stateStore: engine.store });
const recoveredTransitions = apply
  ? reconcileThumbnailQueues(engine.store, { maxTotalAttempts })
  : [];
const queueById = new Map(engine.store.listQueueEntries('thumbnail-refresh')
  .map((entry) => [entry.payload?.queueId, entry.payload]));
const refreshableEntries = requestedThumbnailRefreshEntries(
  engine.store.listDrafts(mediaSlug),
  draftSelectorPresent ? requestedDraftPath : null,
)
  .filter(({ draft }) => draft?.banner?.qa?.policy !== ARTICLE_THUMBNAIL_POLICY || draft?.banner?.qa?.passed !== true)
  .filter(({ draft }) => !newsOnly || draft?.contentType === 'news');
const entries = dueThumbnailRefreshEntries(refreshableEntries, {
  queueById,
  scheduled,
  maxTotalAttempts,
});

const planned = entries.map(({ path, draft }) => ({
  mediaSlug: draft.mediaSlug,
  contentType: draft.contentType,
  title: draft.title,
  slug: draft.slug,
  draftPath: path,
  previousAttempts: Number(queueById.get(thumbnailRefreshQueueId(draft))?.attempts || 0),
}));

if (!apply) {
  console.log(JSON.stringify({ dryRun: true, selected: planned.length, attemptBudget: budget.snapshot(), planned }, null, 2));
  process.exit(0);
}

for (const queued of queueById.values()) {
  if (queued?.status === 'quarantined' && queued.queueId) {
    engine.store.removeQueueEntry('publication-ready', queued.queueId);
  }
}
const results = [];
for (const { path: draftPath, draft: originalDraft } of entries) {
  const media = mediaBySlug(originalDraft.mediaSlug);
  const id = thumbnailRefreshQueueId(originalDraft);
  const previousQueue = queueById.get(id) || {};
  const previousAttempts = Math.max(
    Number(previousQueue.attempts || 0),
    Number(originalDraft?.thumbnailRefresh?.attempts || 0),
    Number(originalDraft?.thumbnailGeneration?.attemptCount || 0),
  );
  if (!media) {
    results.push({ draftPath, status: 'skipped', reason: 'unknown-media' });
    continue;
  }
  if (previousAttempts >= maxTotalAttempts) {
    results.push({ mediaSlug: media.slug, slug: originalDraft.slug, status: 'already-quarantined', attempts: previousAttempts });
    continue;
  }
  if (!budget.canAttempt().allowed) break;

  const attemptAllowance = Math.min(maxAttemptsPerRun, maxTotalAttempts - previousAttempts);
  const candidateRoot = join(engine.store.runtimeDir, 'thumbnail-candidates', 'refresh', media.slug, originalDraft.slug, stamp);
  const thumbnail = await generateThumbnailWithQa({
    hermes: engine.hermes,
    media,
    draft: originalDraft,
    materialize: (imageSource, path) => materializeBanner(imageSource, path, engine.fetchImpl),
    candidatePathForAttempt: (attempt) => join(candidateRoot, `attempt-${previousAttempts + attempt}.webp`),
    budget,
    attemptLedger: {
      store: engine.store,
      key: thumbnailAttemptLedgerKey(originalDraft),
      minimumAttempts: previousAttempts,
      maximumAttempts: maxTotalAttempts,
      scope: scheduled ? 'thumbnail-refresh-timer' : 'thumbnail-refresh-manual',
    },
    maxAttempts: attemptAllowance,
  });
  const attemptState = thumbnailRefreshAttemptState(previousQueue, thumbnail.attempts, {
    maxTotalAttempts,
    reservedAttempts: thumbnail.itemAttempts,
  });
  const allAttempts = attemptState.attemptLog;
  const totalAttempts = attemptState.attempts;
  if (thumbnail.passed) {
    const finalPath = join(engine.store.assetsDir, media.slug, `${originalDraft.slug}.webp`);
    const promoted = promoteThumbnailCandidate(thumbnail.path, finalPath, {
      backupRoot: join(engine.store.runtimeDir, 'backups', 'thumbnail-refresh'),
      mediaSlug: media.slug,
      stamp,
    });
    const refreshedAt = new Date().toISOString();
    const banner = {
      path: finalPath,
      alt: thumbnail.modelResult?.alt || originalDraft.bannerBrief?.alt || originalDraft.title,
      width: 1_280,
      height: 720,
      source: `hermes:image_gen:${ARTICLE_THUMBNAIL_POLICY}`,
      qa: {
        ...thumbnail.qa,
        inspection: { ...thumbnail.qa.inspection, path: finalPath },
      },
      attempts: allAttempts,
    };
    const candidateQueueId = `${media.slug}-${originalDraft.candidateId}`;
    const persistedCandidate = readJson(engine.store.queuePath('qualified', candidateQueueId), null)
      || readJson(engine.store.queuePath('candidates', candidateQueueId), null);
    const candidate = candidateForDraft(originalDraft, persistedCandidate);
    const alreadyPublished = [
      join(engine.store.stateDir, 'wordpress-publication-receipts', media.slug, `${originalDraft.slug}.json`),
      join(engine.store.stateDir, 'publication-receipts', media.slug, `${originalDraft.slug}.json`),
    ].some((path) => existsSync(path));
    const reconciled = reconciledThumbnailDraft({
      originalDraft,
      banner,
      media,
      candidate,
      alreadyPublished,
      refreshedAt,
      backupPath: promoted.backupPath,
      attempts: totalAttempts,
    });
    const publicationQueuePath = persistReconciledThumbnail({
      store: engine.store,
      draftPath,
      ...reconciled,
    });
    engine.store.removeQueueEntry('thumbnail-refresh', id);
    results.push({
      mediaSlug: media.slug,
      slug: reconciled.draft.slug,
      status: reconciled.publicationReady ? 'refreshed-requeued' : 'refreshed-local-only',
      bannerPath: finalPath,
      backupPath: promoted.backupPath,
      attempts: totalAttempts,
      publicationQueuePath,
      publicAssetUpdated: false,
    });
    continue;
  }

  const exhausted = attemptState.exhausted;
  const circuitRetryAt = Date.parse(thumbnail.nextRetryAt || '');
  const nextAttemptAt = exhausted ? null : new Date(Math.max(
    Date.now() + thumbnailRefreshRetryDelayMinutes(totalAttempts) * 60_000,
    Number.isFinite(circuitRetryAt) ? circuitRetryAt : 0,
  )).toISOString();
  const queuePayload = {
    version: 1,
    queueId: id,
    mediaSlug: media.slug,
    contentType: originalDraft.contentType,
    slug: originalDraft.slug,
    title: originalDraft.title,
    draftPath,
    status: exhausted ? 'quarantined' : 'retry-scheduled',
    queuedAt: previousQueue.queuedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attempts: totalAttempts,
    attemptLog: allAttempts,
    nextAttemptAt,
    qa: thumbnail.qa,
    circuitReason: thumbnail.circuitReason,
  };
  engine.store.removeQueueEntry('publication-ready', id);
  engine.store.enqueue('thumbnail-refresh', id, queuePayload);
  failureEvent(engine, originalDraft, draftPath, thumbnail.qa, totalAttempts, queuePayload.status);
  writeJsonAtomic(draftPath, {
    ...originalDraft,
    thumbnailRefresh: {
      ...(originalDraft.thumbnailRefresh || {}),
      policy: ARTICLE_THUMBNAIL_POLICY,
      status: queuePayload.status,
      failedAt: queuePayload.updatedAt,
      attempts: totalAttempts,
      nextAttemptAt,
      qa: thumbnail.qa,
    },
  });
  results.push({ mediaSlug: media.slug, slug: originalDraft.slug, status: queuePayload.status, attempts: totalAttempts, nextAttemptAt, qa: thumbnail.qa });
}

if (budget.openReason) {
  engine.store.enqueue('events', `thumbnail-circuit-open-${stamp}`, {
    version: 1,
    type: 'editorial.engine.degraded',
    scope: 'thumbnail-generation',
    createdAt: new Date().toISOString(),
    reason: budget.openReason,
    budget: budget.snapshot(),
  });
}

console.log(JSON.stringify({
  dryRun: false,
  scheduled,
  recoveredTransitions,
  selected: planned.length,
  processed: results.length,
  budget: budget.snapshot(),
  results,
}, null, 2));
process.exitCode = thumbnailRefreshExitCode(results, { scheduled });
} finally {
  if (refreshLease) engine.store.releaseLease(refreshLease);
}
