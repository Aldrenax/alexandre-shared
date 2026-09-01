import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MediaStateStore } from '../media/state-store.mjs';
import { WordPressPublicationWorker } from '../media/wordpress-publication-worker.mjs';
import { ARTICLE_THUMBNAIL_POLICY } from '../media/thumbnail-policy.mjs';

const NOW = new Date('2026-08-24T09:00:00.000Z');

function eligibleDraft(overrides = {}) {
  return {
    mediaSlug: 'chaimbault',
    contentType: 'news',
    candidateId: 'candidate-direct',
    slug: 'publication-directe',
    title: 'Publication directe WordPress',
    generatedAt: NOW.toISOString(),
    publicationMode: 'draft',
    qa: { passed: true },
    banner: {
      path: '/tmp/approved-thumbnail.webp',
      alt: 'Miniature validée',
      width: 1_280,
      height: 720,
      qa: { passed: true, policy: ARTICLE_THUMBNAIL_POLICY, issues: [] },
    },
    publicationEligibility: { status: 'eligible' },
    ...overrides,
  };
}

test('publication WordPress: seul un brouillon explicitement en file est publi\u00e9', async () => {
  const store = new MediaStateStore(mkdtempSync(join(tmpdir(), 'wordpress-publication-queue-')));
  store.initialize();
  const draft = eligibleDraft();
  const draftPath = store.saveDraft('chaimbault', draft);
  store.enqueuePublicationReady(draftPath, draft, { now: NOW });
  // Ce brouillon historique, absent de la file, ne doit jamais \u00eatre repris en masse.
  store.saveDraft('chaimbault', eligibleDraft({ candidateId: 'historique', slug: 'historique-non-file', generatedAt: '2026-08-01T09:00:00.000Z' }));
  const worker = new WordPressPublicationWorker({
    store,
    now: () => NOW,
    env: {
      MEDIA_ENGINE_PUBLICATION_MODE: 'automatic',
      MEDIA_ENGINE_AUTOMATIC_PUBLICATION_APPROVED: 'true',
      MEDIA_ENGINE_PUSH_ENABLED: 'true',
      MEDIA_ENGINE_SHADOW_STARTED_AT: '2026-08-01T00:00:00.000Z',
      MEDIA_ENGINE_SHADOW_DAYS_REQUIRED: '0',
    },
  });
  worker.publishDraftPath = async (path) => ({
    status: 'published',
    publishedAt: NOW.toISOString(),
    mediaSlug: 'chaimbault',
    contentType: 'news',
    slug: 'publication-directe',
    draftPath: path,
  });

  const result = await worker.run({ limit: 1 });
  assert.equal(result.inspected, 1);
  assert.equal(result.results.length, 1);
  assert.equal(store.listQueueEntries('publication-ready').length, 0);
  assert.equal(result.results[0].slug, 'publication-directe');
});
