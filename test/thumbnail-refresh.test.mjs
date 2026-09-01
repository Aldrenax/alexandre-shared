import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MediaStateStore, writeJsonAtomic } from '../media/state-store.mjs';
import {
  persistReconciledThumbnail,
  reconciledThumbnailDraft,
  refreshableThumbnailDrafts,
  representativeThumbnailBatch,
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
