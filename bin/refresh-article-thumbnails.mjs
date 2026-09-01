#!/usr/bin/env node

import { join } from 'node:path';
import { MediaEngine, materializeBanner } from '../media/engine.mjs';
import { ARTICLE_THUMBNAIL_POLICY } from '../media/editorial.mjs';
import { loadEnvironmentFile } from '../media/environment.mjs';
import { mediaBySlug } from '../media/registry.mjs';
import { writeJsonAtomic } from '../media/state-store.mjs';
import {
  generateThumbnailWithQa,
  promoteThumbnailCandidate,
  ThumbnailGenerationBudget,
} from '../media/thumbnail-generation.mjs';
import { thumbnailRefreshSelection } from '../media/thumbnail-refresh.mjs';

loadEnvironmentFile(process.env.MEDIA_ENGINE_ENV_FILE || '/etc/alexandre-media-engine/media-engine.env');

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function due(value, now = new Date()) {
  const timestamp = Date.parse(value || '');
  return !Number.isFinite(timestamp) || timestamp <= now.getTime();
}

function retryDelayMinutes(attempts) {
  return Math.min(1_440, 15 * (2 ** Math.max(0, attempts - 1)));
}

function queueId(draft) {
  return `${draft.mediaSlug}-${draft.contentType}-${draft.slug}`;
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
const newsOnly = process.argv.includes('--news-only');
const mediaSlug = argument('--media');
if (process.argv.includes('--limit')) {
  throw new Error('--limit a été supprimé: tous les contenus sont sélectionnés; utilisez --budget pour borner les tentatives globales');
}

const engine = new MediaEngine();
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const maxAttemptsPerRun = positiveInteger(
  argument('--max-attempts-per-thumbnail', process.env.MEDIA_ENGINE_THUMBNAIL_MAX_ATTEMPTS_PER_ITEM),
  3,
);
const maxTotalAttempts = positiveInteger(process.env.MEDIA_ENGINE_THUMBNAIL_MAX_TOTAL_ATTEMPTS_PER_ITEM, 9);
const budget = ThumbnailGenerationBudget.fromEnvironment({
  ...process.env,
  MEDIA_ENGINE_THUMBNAIL_GLOBAL_ATTEMPT_BUDGET: argument('--budget', process.env.MEDIA_ENGINE_THUMBNAIL_GLOBAL_ATTEMPT_BUDGET),
});
const queueById = new Map(engine.store.listQueueEntries('thumbnail-refresh')
  .map((entry) => [entry.payload?.queueId, entry.payload]));
const entries = thumbnailRefreshSelection(engine.store.listDrafts(mediaSlug))
  .filter(({ draft }) => draft?.banner?.qa?.policy !== ARTICLE_THUMBNAIL_POLICY || draft?.banner?.qa?.passed !== true)
  .filter(({ draft }) => !newsOnly || draft?.contentType === 'news')
  .filter(({ draft }) => {
    const queued = queueById.get(queueId(draft));
    return !queued?.nextAttemptAt || due(queued.nextAttemptAt);
  });

const planned = entries.map(({ path, draft }) => ({
  mediaSlug: draft.mediaSlug,
  contentType: draft.contentType,
  title: draft.title,
  slug: draft.slug,
  draftPath: path,
  previousAttempts: Number(queueById.get(queueId(draft))?.attempts || 0),
}));

if (!apply) {
  console.log(JSON.stringify({ dryRun: true, selected: planned.length, attemptBudget: budget.snapshot(), planned }, null, 2));
  process.exit(0);
}

engine.store.initialize();
const results = [];
for (const { path: draftPath, draft: originalDraft } of entries) {
  const media = mediaBySlug(originalDraft.mediaSlug);
  const id = queueId(originalDraft);
  const previousQueue = queueById.get(id) || {};
  const previousAttempts = Number(previousQueue.attempts || 0);
  if (!media) {
    results.push({ draftPath, status: 'skipped', reason: 'unknown-media' });
    continue;
  }
  if (previousAttempts >= maxTotalAttempts) {
    const qa = previousQueue.qa || { passed: false, issues: [{ code: 'thumbnail-retry-budget-exhausted', severity: 'error' }] };
    failureEvent(engine, originalDraft, draftPath, qa, previousAttempts, 'quarantined');
    results.push({ mediaSlug: media.slug, slug: originalDraft.slug, status: 'quarantined', attempts: previousAttempts, qa });
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
    maxAttempts: attemptAllowance,
  });
  const allAttempts = [...(previousQueue.attemptLog || []), ...thumbnail.attempts];
  const totalAttempts = previousAttempts + thumbnail.attempts.length;
  if (thumbnail.passed) {
    const finalPath = join(engine.store.assetsDir, media.slug, `${originalDraft.slug}.webp`);
    const promoted = promoteThumbnailCandidate(thumbnail.path, finalPath, {
      backupRoot: join(engine.store.runtimeDir, 'backups', 'thumbnail-refresh'),
      mediaSlug: media.slug,
      stamp,
    });
    const refreshedAt = new Date().toISOString();
    const draft = {
      ...originalDraft,
      banner: {
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
      },
      thumbnailRefresh: {
        refreshedAt,
        backupPath: promoted.backupPath,
        policy: ARTICLE_THUMBNAIL_POLICY,
        status: 'qa-passed',
        attempts: totalAttempts,
        scope: 'local-draft-only',
      },
    };
    writeJsonAtomic(draftPath, draft);
    engine.store.removeQueueEntry('thumbnail-refresh', id);
    results.push({ mediaSlug: media.slug, slug: draft.slug, status: 'refreshed', bannerPath: finalPath, backupPath: promoted.backupPath, attempts: totalAttempts });
    continue;
  }

  const exhausted = totalAttempts >= maxTotalAttempts;
  const nextAttemptAt = exhausted ? null : new Date(Date.now() + retryDelayMinutes(totalAttempts) * 60_000).toISOString();
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

console.log(JSON.stringify({ dryRun: false, selected: planned.length, processed: results.length, budget: budget.snapshot(), results }, null, 2));
if (results.some((result) => ['retry-scheduled', 'quarantined'].includes(result.status))) process.exitCode = 1;
