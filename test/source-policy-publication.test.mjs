import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ARTICLE_THUMBNAIL_POLICY } from '../media/thumbnail-policy.mjs';
import { PublicationWorker } from '../media/publication-worker.mjs';
import { candidateForDraft, hydrateConfiguredSourcePolicies } from '../media/source-policy.mjs';
import { MediaStateStore } from '../media/state-store.mjs';
import { WordPressPublicationWorker } from '../media/wordpress-publication-worker.mjs';

const SOURCE_URL = 'https://www.ecb.europa.eu/press/blog/date/2026/html/ecb.blog20260901~example.en.html';

function legacyCandidate() {
  return {
    id: 'legacy-ecb-blog',
    mediaSlug: 'investissement',
    status: 'qualified',
    corroborated: true,
    rumor: false,
    sources: [{
      sourceId: 'ecb-blog',
      tier: 0,
      official: true,
      title: 'Why the drivers of inflation matter',
      url: SOURCE_URL,
      publishedAt: '2026-09-01T07:00:00.000Z',
      kind: 'news',
    }],
  };
}

function staleEligibleDraft(bannerPath) {
  return {
    candidateId: 'legacy-ecb-blog',
    mediaSlug: 'investissement',
    contentType: 'news',
    section: 'actualites',
    title: 'Inflation : la BCE estime que le choc énergétique domine',
    slug: 'inflation-bce-choc-energetique',
    description: 'Analyse de la récente hausse de l’inflation en zone euro.',
    body: [
      'La BCE estime que le choc énergétique explique la hausse récente.',
      `[Source](${SOURCE_URL}).`,
      'Ce contenu ne constitue pas un conseil en investissement.',
      'Tout investissement comporte un risque de perte en capital, partielle ou totale.',
    ].join('\n\n'),
    wordCount: 1_200,
    category: 'analyse',
    sourceUrls: [SOURCE_URL],
    claims: [{ statement: 'La BCE attribue la hausse au choc énergétique.', sourceRefs: ['S1'] }],
    generatedAt: '2026-09-01T08:00:00.000Z',
    scheduledPublishAt: '2026-09-01T08:30:00.000Z',
    publicationMode: 'draft',
    banner: {
      path: bannerPath,
      alt: 'Inflation et énergie',
      qa: { passed: true, policy: ARTICLE_THUMBNAIL_POLICY, issues: [] },
    },
    qa: { version: 1, passed: true, issues: [] },
    publicationEligibility: { status: 'eligible' },
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'source-policy-publication-'));
  const store = new MediaStateStore(root);
  store.initialize();
  const bannerPath = join(root, 'banner.webp');
  writeFileSync(bannerPath, Buffer.alloc(9_000, 7));
  const candidate = legacyCandidate();
  store.enqueue('qualified', `investissement-${candidate.id}`, candidate);
  const draft = staleEligibleDraft(bannerPath);
  const draftPath = store.saveDraft('investissement', draft);
  return { store, draft, draftPath };
}

test('source policy: la configuration hydrate une ancienne candidate et reste autoritaire', () => {
  const hydrated = hydrateConfiguredSourcePolicies({
    ...legacyCandidate(),
    sources: [{ ...legacyCandidate().sources[0], sourcePolicy: 'valeur-obsolete' }],
  }, 'investissement');
  assert.equal(hydrated.sources[0].sourcePolicy, 'author-views');
  assert.equal(candidateForDraft({ contentType: 'news', mediaSlug: 'investissement' }), null);
});

test('publication: une ancienne QA verte BCE Blog est revalidee et bloquee', () => {
  const { store, draft } = fixture();
  const worker = new PublicationWorker({
    store,
    env: {
      MEDIA_ENGINE_PUBLICATION_MODE: 'automatic',
      MEDIA_ENGINE_AUTOMATIC_PUBLICATION_APPROVED: 'true',
      MEDIA_ENGINE_PUSH_ENABLED: 'true',
      MEDIA_ENGINE_SHADOW_STARTED_AT: '2026-08-01T00:00:00.000Z',
    },
    now: () => new Date('2026-09-01T09:00:00.000Z'),
  });
  const decision = worker.decisionFor(draft);
  assert.equal(decision.allowed, false);
  assert.ok(decision.blockers.includes('qa-failed'));
  assert.ok(decision.qa.issues.some((entry) => entry.code === 'author-views-institutional-attribution'));
});

test('publication WordPress: syncReadyQueue ne refile pas un verdict anterieur a la politique', () => {
  const { store } = fixture();
  const worker = new WordPressPublicationWorker({
    store,
    now: () => new Date('2026-09-01T09:00:00.000Z'),
  });
  assert.deepEqual(worker.syncReadyQueue(), []);
  assert.equal(store.listQueueEntries('publication-ready').length, 0);
});

test('publication WordPress: une entree deja en file reste bloquee apres revalidation', async () => {
  const { store, draft, draftPath } = fixture();
  store.enqueuePublicationReady(draftPath, draft);
  const worker = new WordPressPublicationWorker({
    store,
    env: {
      MEDIA_ENGINE_PUBLICATION_MODE: 'automatic',
      MEDIA_ENGINE_AUTOMATIC_PUBLICATION_APPROVED: 'true',
      MEDIA_ENGINE_PUSH_ENABLED: 'true',
      MEDIA_ENGINE_SHADOW_STARTED_AT: '2026-08-01T00:00:00.000Z',
      MEDIA_ENGINE_SHADOW_DAYS_REQUIRED: '0',
    },
    now: () => new Date('2026-09-01T09:00:00.000Z'),
  });
  worker.publishDraftPath = async () => {
    throw new Error('un brouillon author-views invalide ne doit pas atteindre le publieur');
  };
  const result = await worker.run({ limit: 1 });
  assert.equal(result.results.length, 0);
  assert.ok(result.held.some((entry) => entry.blockers.includes('qa-failed')));
  assert.equal(store.listQueueEntries('publication-ready').length, 1);
});
