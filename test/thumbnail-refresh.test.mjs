import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ARTICLE_THUMBNAIL_POLICY } from '../media/editorial.mjs';
import { MediaStateStore, writeJsonAtomic } from '../media/state-store.mjs';
import {
  dueThumbnailRefreshEntries,
  persistReconciledThumbnail,
  reconciledThumbnailDraft,
  reconcileThumbnailQueues,
  refreshableThumbnailDrafts,
  representativeThumbnailBatch,
  thumbnailRefreshAttemptState,
  thumbnailRefreshExitCode,
  thumbnailRefreshQueueDecision,
} from '../media/thumbnail-refresh.mjs';

const entry = (path, mediaSlug, contentType) => ({ path, draft: { mediaSlug, contentType } });

test('thumbnail refresh: ne sélectionne que les Actualités et Guides', () => {
  const entries = [
    entry('/d/video.json', 'chaimbault', 'video'),
    entry('/d/news.json', 'chaimbault', 'news'),
    entry('/d/guide.json', 'tesla-tech', 'guide'),
  ];
  assert.deepEqual(refreshableThumbnailDrafts(entries).map((item) => item.draft.contentType), ['guide', 'news']);
});

test('thumbnail refresh: tous les contenus éligibles sont sélectionnés sans plafond arbitraire', () => {
  const entries = [
    entry('/d/chaimbault-b.json', 'chaimbault', 'news'),
    entry('/d/chaimbault-a.json', 'chaimbault', 'guide'),
    entry('/d/tesla-a.json', 'tesla-tech', 'news'),
    entry('/d/video.json', 'logiciels', 'video'),
  ];
  assert.deepEqual(
    representativeThumbnailBatch(entries, { limit: 1 }).map((item) => item.path),
    ['/d/chaimbault-a.json', '/d/chaimbault-b.json', '/d/tesla-a.json'],
  );
});

test('thumbnail refresh: une quarantaine épuisée ne repart ni immédiatement ni indéfiniment', () => {
  const now = new Date('2026-09-01T08:00:00.000Z');
  assert.deepEqual(
    thumbnailRefreshQueueDecision({ status: 'quarantined', attempts: 9, nextAttemptAt: null }, { maxTotalAttempts: 9, now }),
    { selected: false, reason: 'quarantined' },
  );
  assert.equal(thumbnailRefreshQueueDecision({ status: 'retry-scheduled', attempts: 3, nextAttemptAt: '2026-09-01T09:00:00.000Z' }, { now }).selected, false);
  assert.equal(thumbnailRefreshQueueDecision({ status: 'retry-scheduled', attempts: 3, nextAttemptAt: '2026-09-01T07:00:00.000Z' }, { now }).selected, true);
});

test('thumbnail refresh: le cumul reste borné à 9 entre cooldowns puis passe en quarantaine', () => {
  let queue = { attempts: 1, attemptLog: [{ attempt: 1 }] };
  const observed = [];
  for (const generated of [
    [{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }],
    [{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }],
    [{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }],
  ]) {
    const state = thumbnailRefreshAttemptState(queue, generated, {
      maxTotalAttempts: 9,
      reservedAttempts: queue.attempts + generated.length,
    });
    observed.push(state.attempts);
    queue = { attempts: state.attempts, attemptLog: state.attemptLog };
  }
  assert.deepEqual(observed, [4, 7, 9]);
  assert.equal(queue.attempts, 9);
  assert.equal(queue.attemptLog.length, 9);
  const exhausted = thumbnailRefreshAttemptState(queue, [{ attempt: 10 }], {
    maxTotalAttempts: 9,
    reservedAttempts: 10,
  });
  assert.equal(exhausted.attempts, 9);
  assert.equal(exhausted.attemptLog.length, 9);
  assert.equal(exhausted.exhausted, true);
  assert.equal(exhausted.remainingAttempts, 0);
});

test('thumbnail refresh: le timer ne traite que les entrées persistantes arrivées à échéance', () => {
  const now = new Date('2026-09-01T08:00:00.000Z');
  const queued = entry('/d/queued.json', 'chaimbault', 'news');
  queued.draft.slug = 'queued';
  const future = entry('/d/future.json', 'logiciels', 'news');
  future.draft.slug = 'future';
  const legacy = entry('/d/legacy.json', 'tesla-tech', 'news');
  legacy.draft.slug = 'legacy';
  const queueById = new Map([
    ['chaimbault-news-queued', { status: 'retry-scheduled', attempts: 3, nextAttemptAt: '2026-09-01T07:00:00.000Z' }],
    ['logiciels-news-future', { status: 'retry-scheduled', attempts: 3, nextAttemptAt: '2026-09-01T09:00:00.000Z' }],
  ]);
  assert.deepEqual(
    dueThumbnailRefreshEntries([legacy, future, queued], { queueById, scheduled: true, now }).map(({ path }) => path),
    ['/d/queued.json'],
  );
  assert.deepEqual(
    dueThumbnailRefreshEntries([legacy, future, queued], { queueById, scheduled: false, now }).map(({ path }) => path),
    ['/d/legacy.json', '/d/queued.json'],
  );
});

test('thumbnail refresh: le mode planifié conserve les incidents sans marquer systemd failed', () => {
  const expectedQaOutcomes = [
    { status: 'retry-scheduled' },
    { status: 'quarantined' },
  ];
  assert.equal(thumbnailRefreshExitCode(expectedQaOutcomes), 1);
  assert.equal(thumbnailRefreshExitCode(expectedQaOutcomes, { scheduled: true }), 0);
  assert.equal(thumbnailRefreshExitCode([{ status: 'skipped', reason: 'unknown-media' }], { scheduled: true }), 1);
});

test('thumbnail refresh: réconcilie uniquement les transitions explicites après cutover', () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'thumbnail-refresh-reconcile-'));
  const store = new MediaStateStore(runtimeDir);
  const now = new Date('2026-09-01T10:00:00.000Z');
  const failedPath = store.saveDraft('chaimbault', {
    mediaSlug: 'chaimbault',
    contentType: 'news',
    candidateId: 'failed-transition',
    slug: 'failed-transition',
    title: 'Failed transition',
    generatedAt: '2026-09-01T09:00:00.000Z',
    banner: { qa: { passed: false, policy: ARTICLE_THUMBNAIL_POLICY }, attempts: [{ attempt: 1 }] },
    thumbnailGeneration: {
      status: 'deferred',
      retryOwner: 'thumbnail-refresh',
      attemptCount: 1,
      nextRetryAt: '2026-09-01T10:30:00.000Z',
    },
    qa: { passed: false },
    publicationEligibility: { status: 'blocked' },
  });
  store.saveDraft('logiciels', {
    mediaSlug: 'logiciels',
    contentType: 'news',
    candidateId: 'historical-generic',
    slug: 'historical-generic',
    title: 'Historical generic',
    generatedAt: '2026-08-01T09:00:00.000Z',
    banner: { qa: { passed: true, policy: ARTICLE_THUMBNAIL_POLICY } },
    qa: { passed: true },
    publicationEligibility: { status: 'eligible' },
  });

  const recovered = reconcileThumbnailQueues(store, {
    now,
    publicationCutoverAt: '2026-09-01T00:00:00.000Z',
  });
  const [refresh] = store.listQueueEntries('thumbnail-refresh');
  assert.equal(refresh.payload.draftPath, failedPath);
  assert.equal(refresh.payload.attempts, 1);
  assert.equal(refresh.payload.recoveredFromDraft, true);
  assert.ok(Date.parse(refresh.payload.nextAttemptAt) >= Date.parse('2026-09-01T10:30:00.000Z'));
  assert.deepEqual(recovered.map((item) => item.action), ['thumbnail-refresh-restored']);
  assert.equal(store.listQueueEntries('publication-ready').length, 0);
});

test('thumbnail refresh: un cutover invalide échoue fermé sans reconstruire de file historique', () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'thumbnail-refresh-invalid-cutover-'));
  const store = new MediaStateStore(runtimeDir);
  store.saveDraft('chaimbault', {
    mediaSlug: 'chaimbault',
    contentType: 'news',
    candidateId: 'historical-explicit',
    slug: 'historical-explicit',
    title: 'Historical explicit',
    generatedAt: '2026-08-01T09:00:00.000Z',
    banner: { qa: { passed: true, policy: ARTICLE_THUMBNAIL_POLICY } },
    thumbnailGeneration: { status: 'passed' },
    qa: { passed: true },
    publicationEligibility: { status: 'eligible' },
  });
  assert.throws(
    () => reconcileThumbnailQueues(store, { publicationCutoverAt: 'date-invalide' }),
    /CUTOVER_AT invalide/,
  );
  assert.equal(store.listQueueEntries('publication-ready').length, 0);
  assert.equal(store.listQueueEntries('thumbnail-refresh').length, 0);
});

test('thumbnail refresh: restaure publication-ready après crash mais jamais un reçu déjà publié', () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'thumbnail-publication-reconcile-'));
  const store = new MediaStateStore(runtimeDir);
  const draft = {
    mediaSlug: 'chaimbault',
    contentType: 'news',
    candidateId: 'eligible-transition',
    slug: 'eligible-transition',
    title: 'Eligible transition',
    generatedAt: '2026-09-01T09:00:00.000Z',
    banner: { qa: { passed: true, policy: ARTICLE_THUMBNAIL_POLICY } },
    thumbnailRefresh: { status: 'qa-passed-requeued', refreshedAt: '2026-09-01T09:30:00.000Z' },
    qa: { passed: true },
    publicationEligibility: { status: 'eligible' },
  };
  const draftPath = store.saveDraft('chaimbault', draft);
  const queueId = 'chaimbault-news-eligible-transition';
  store.enqueue('thumbnail-refresh', queueId, { queueId, draftPath, status: 'retry-scheduled' });
  const recovered = reconcileThumbnailQueues(store, { now: new Date('2026-09-01T10:00:00.000Z') });
  assert.deepEqual(recovered.map((item) => item.action), [
    'publication-ready-restored',
    'thumbnail-refresh-completed',
  ]);
  assert.equal(store.listQueueEntries('publication-ready').length, 1);
  assert.equal(store.listQueueEntries('thumbnail-refresh').length, 0);

  const published = { ...draft, candidateId: 'published-transition', slug: 'published-transition' };
  const publishedPath = store.saveDraft('chaimbault', published);
  const publishedId = 'chaimbault-news-published-transition';
  store.enqueue('thumbnail-refresh', publishedId, { queueId: publishedId, draftPath: publishedPath, status: 'retry-scheduled' });
  writeJsonAtomic(
    join(store.stateDir, 'publication-receipts', 'chaimbault', 'published-transition.json'),
    { status: 'published' },
  );
  reconcileThumbnailQueues(store, { now: new Date('2026-09-01T10:00:00.000Z') });
  assert.equal(store.listQueueEntries('publication-ready')
    .some((entryValue) => entryValue.payload.slug === 'published-transition'), false);
  assert.equal(store.listQueueEntries('thumbnail-refresh')
    .some((entryValue) => entryValue.payload.slug === 'published-transition'), false);
});

test('thumbnail refresh: une réparation QA réussie recalcule l’éligibilité et réinscrit une seule fois le brouillon', () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'thumbnail-refresh-'));
  const store = new MediaStateStore(runtimeDir);
  store.initialize();
  const draftPath = join(runtimeDir, 'draft.json');
  const originalDraft = {
    mediaSlug: 'chaimbault',
    contentType: 'news',
    candidateId: 'candidate-1',
    slug: 'miniature-reparee',
    title: 'Miniature réparée',
    scheduledPublishAt: '2026-09-01T09:00:00.000Z',
    candidateQualification: { profile: 'strict' },
    publicationEligibility: { status: 'blocked', reason: 'qa-failed' },
  };
  const reconciled = reconciledThumbnailDraft({
    originalDraft,
    banner: { path: '/tmp/final.webp', qa: { passed: true, policy: 'v3' } },
    media: { slug: 'chaimbault' },
    candidate: { status: 'qualified' },
    refreshedAt: '2026-09-01T08:00:00.000Z',
    evaluateQa: () => ({ passed: true, issues: [] }),
  });
  const first = persistReconciledThumbnail({ store, draftPath, ...reconciled });
  const second = persistReconciledThumbnail({ store, draftPath, ...reconciled });
  assert.equal(reconciled.draft.qa.passed, true);
  assert.equal(reconciled.draft.publicationEligibility.status, 'eligible');
  assert.ok(first);
  assert.equal(second, first);
  assert.equal(store.listQueueEntries('publication-ready').length, 1);
  assert.equal(JSON.parse(readFileSync(draftPath, 'utf8')).thumbnailRefresh.status, 'qa-passed-requeued');
});

test('thumbnail refresh: un article déjà publié reste local-only et retire toute file de republication', () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'thumbnail-published-'));
  const store = new MediaStateStore(runtimeDir);
  store.initialize();
  const draftPath = join(runtimeDir, 'published.json');
  const originalDraft = {
    mediaSlug: 'tesla-tech',
    contentType: 'news',
    candidateId: 'candidate-2',
    slug: 'deja-publie',
    title: 'Déjà publié',
    publicationEligibility: { status: 'eligible' },
  };
  store.enqueue('publication-ready', 'tesla-tech-news-deja-publie', { queueId: 'tesla-tech-news-deja-publie' });
  const reconciled = reconciledThumbnailDraft({
    originalDraft,
    banner: { path: '/tmp/final.webp', qa: { passed: true, policy: 'v3' } },
    media: { slug: 'tesla-tech' },
    candidate: { status: 'qualified' },
    alreadyPublished: true,
    refreshedAt: '2026-09-01T08:00:00.000Z',
    evaluateQa: () => ({ passed: true, issues: [] }),
  });
  const queued = persistReconciledThumbnail({ store, draftPath, ...reconciled });
  assert.equal(queued, null);
  assert.equal(store.listQueueEntries('publication-ready').length, 0);
  assert.equal(reconciled.draft.publicationEligibility.status, 'published');
  assert.equal(reconciled.draft.thumbnailRefresh.publicAssetUpdated, false);
  assert.equal(reconciled.draft.thumbnailRefresh.scope, 'local-draft-only-published-asset-unchanged');
});
