import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildQualifiedCandidatePool,
  MediaEngine,
  normalizeEnrichedXEvidence,
  pendingEligibleNewsDraft,
  verifiedOfficialXPost,
  xItems,
  xSnowflakePublishedAt,
} from '../media/engine.mjs';
import { mediaBySlug } from '../media/registry.mjs';
import { MediaStateStore } from '../media/state-store.mjs';

function snowflakeFor(isoDate) {
  const epoch = 1_288_834_974_657n;
  return String((BigInt(Date.parse(isoDate)) - epoch) << 22n);
}

function officialCandidate(id, title, url, publishedAt = new Date().toISOString()) {
  return {
    id,
    mediaSlug: 'logiciels',
    title,
    primaryUrl: url,
    publishedAt,
    status: 'qualified',
    sources: [{
      sourceId: `official-${id}`,
      tier: 1,
      official: true,
      title,
      url,
      excerpt: `${title} est une annonce officielle récente.`,
      publishedAt,
      kind: 'news',
    }],
  };
}

test('X: seule une URL directe dont le handle est autorisé devient officielle', () => {
  const media = mediaBySlug('logiciels');
  const statusId = snowflakeFor('2026-08-14T08:00:00.000Z');
  const direct = { url: `https://x.com/OpenAI/status/${statusId}`, author: 'OpenAI' };
  const opaque = { url: `https://x.com/i/status/${statusId}`, author: 'OpenAI', official: true };
  const unrelated = { url: `https://x.com/randomvendor/status/${statusId}`, author: 'OpenAI', official: true };
  assert.equal(verifiedOfficialXPost(direct, media, ['OpenAI']), true);
  assert.equal(verifiedOfficialXPost(opaque, media, ['OpenAI']), false);
  assert.equal(verifiedOfficialXPost(unrelated, media, ['OpenAI']), false);
  assert.equal(xSnowflakePublishedAt(statusId), '2026-08-14T08:00:00.000Z');

  const items = xItems({
    degraded: false,
    officialSearch: true,
    allowedHandles: ['OpenAI'],
    posts: [direct, opaque],
    answer: 'Annonce logicielle',
  }, media);
  assert.equal(items[0].sourceOfficial, true);
  assert.equal(items[0].sourceTier, 1);
  assert.equal(items[0].publishedAt, '2026-08-14T08:00:00.000Z');
  assert.equal(items[1].sourceOfficial, false);
  assert.equal(items[1].sourceTier, 3);

  const structuredSummary = 'Annonce officielle structurée et suffisamment détaillée pour constituer la preuve primaire du changement présenté par le compte autorisé.';
  const enriched = {
    evidenceAvailableCount: 2,
    sources: [
      { sourceId: 'x-search', kind: 'x-search', url: direct.url, official: true, tier: 1, excerpt: 'Page HTML générique de connexion '.repeat(5), evidenceStatus: 'available' },
      { sourceId: 'x-search', kind: 'x-search', url: opaque.url, official: true, tier: 1, excerpt: 'Page HTML générique de connexion '.repeat(5), evidenceStatus: 'available' },
      { sourceId: 'x-search', kind: 'x-search', url: 'https://x.com/randomvendor/status/123', official: false, tier: 3, excerpt: 'Page HTML générique de connexion '.repeat(5), evidenceStatus: 'available' },
    ],
  };
  const normalized = normalizeEnrichedXEvidence(enriched, media, {
    sources: [
      { sourceId: 'x-search', url: direct.url, excerpt: structuredSummary },
      { sourceId: 'x-search', url: opaque.url, excerpt: structuredSummary },
      { sourceId: 'x-search', url: 'https://x.com/randomvendor/status/123', excerpt: structuredSummary },
    ],
  });
  assert.equal(normalized.sources[0].evidenceKind, 'verified-x-search-post');
  assert.equal(normalized.sources[0].excerpt, structuredSummary);
  assert.equal(normalized.sources[1].evidenceStatus, 'unavailable');
  assert.equal(normalized.sources[1].official, false);
  assert.equal(normalized.sources[2].evidenceStatus, 'unavailable');
  assert.equal(normalized.sources[2].official, false);
  assert.equal(normalized.evidenceAvailableCount, 1);
});

test('file: les candidats frais persistés sont requalifiés, les anciens sont exclus', () => {
  const now = new Date('2026-08-14T12:00:00.000Z');
  const fresh = officialCandidate('fresh', 'OpenAI annonce un logiciel SaaS', 'https://openai.com/index/fresh', '2026-08-14T08:00:00.000Z');
  const stale = officialCandidate('stale', 'OpenAI annonce un ancien logiciel SaaS', 'https://openai.com/index/stale', '2026-07-01T08:00:00.000Z');
  const pool = buildQualifiedCandidatePool({
    queueEntries: [
      { payload: fresh, mtimeMs: now.getTime() },
      { payload: stale, mtimeMs: now.getTime() },
    ],
    media: [mediaBySlug('logiciels')],
    now,
  });
  assert.deepEqual(pool.map((candidate) => candidate.id), ['fresh']);
});

test('cycle: un premier candidat sans preuve ne bloque plus le suivant de la file', async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'media-queue-drain-'));
  const store = new MediaStateStore(runtimeDir);
  store.initialize();
  const first = officialCandidate('first', 'OpenAI annonce un logiciel SaaS marketing', 'https://openai.com/index/first');
  const second = officialCandidate('second', 'OpenAI annonce un logiciel de productivité', 'https://openai.com/index/second');
  store.upsertObserved('qualified', 'logiciels-first', first);
  store.upsertObserved('qualified', 'logiciels-second', second);

  const engine = new MediaEngine({
    store,
    env: { MEDIA_ENGINE_X_SEARCH_ENABLED: 'false' },
    enrichCandidateEvidenceImpl: async (candidate) => ({
      ...candidate,
      sources: candidate.sources.map((source) => ({
        ...source,
        evidenceStatus: candidate.id === 'first' ? 'unavailable' : 'available',
      })),
      evidenceAvailableCount: candidate.id === 'first' ? 0 : 1,
    }),
  });
  engine.collect = async () => [];
  engine.researchX = async () => [];
  engine.qualify = () => [];
  engine.generateDraft = async (candidate) => ({
    status: 'draft',
    mediaSlug: candidate.mediaSlug,
    candidateId: candidate.id,
    qa: { passed: true, issues: [] },
  });

  const result = await engine.runCycle({ mediaSlug: 'logiciels' });
  assert.equal(result.drafts.length, 1);
  assert.equal(result.drafts[0].candidateId, 'second');
  assert.equal(store.getEvent('draft:logiciels:first:news').status, 'retryable-failure');
  assert.equal(store.getEvent('draft:logiciels:second:news').status, 'qa-passed');
  assert.equal(store.listQueueEntries('events').filter((entry) => entry.payload.type === 'editorial.engine.degraded').length, 1);
});

test('cycle: les candidats déjà traités ne consomment pas le plafond de lecture', async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'media-processed-drain-'));
  const store = new MediaStateStore(runtimeDir);
  store.initialize();
  const processed = Array.from({ length: 25 }, (_, index) => officialCandidate(
    `processed-${String(index).padStart(2, '0')}`,
    `OpenAI annonce un logiciel SaaS déjà traité ${index}`,
    `https://openai.com/index/processed-${index}`,
  ));
  const fresh = officialCandidate('fresh-after-processed', 'OpenAI annonce un nouveau logiciel SaaS', 'https://openai.com/index/fresh-after-processed');
  for (const candidate of processed) {
    store.markEvent(`draft:logiciels:${candidate.id}:news`, { status: 'qa-passed' });
  }

  const engine = new MediaEngine({
    store,
    env: { MEDIA_ENGINE_X_SEARCH_ENABLED: 'false' },
    enrichCandidateEvidenceImpl: async (candidate) => ({
      ...candidate,
      sources: candidate.sources.map((source) => ({ ...source, evidenceStatus: 'available' })),
      evidenceAvailableCount: 1,
    }),
  });
  engine.collect = async () => [];
  engine.researchX = async () => [];
  engine.qualify = () => [...processed, fresh];
  engine.generateDraft = async (candidate) => ({
    status: 'draft',
    mediaSlug: candidate.mediaSlug,
    candidateId: candidate.id,
    qa: { passed: true, issues: [] },
  });

  const result = await engine.runCycle({ mediaSlug: 'logiciels' });
  assert.equal(result.drafts.length, 1);
  assert.equal(result.drafts[0].candidateId, 'fresh-after-processed');
});

test('cycle: un risque Tesla révélé par enrichissement réactive la preuve officielle', async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'media-product-safety-enriched-'));
  const store = new MediaStateStore(runtimeDir);
  store.initialize();
  const publishedAt = new Date().toISOString();
  const candidate = {
    id: 'tesla-risk-after-enrichment',
    mediaSlug: 'tesla-tech',
    title: 'Tesla présente une nouvelle offre Powerwall',
    primaryUrl: 'https://source-a.test/tesla-powerwall',
    publishedAt,
    status: 'qualified',
    officialRequired: false,
    sources: [
      { sourceId: 'a', tier: 2, official: false, title: 'Tesla Powerwall', url: 'https://source-a.test/tesla-powerwall', excerpt: 'Nouvelle offre résidentielle.', publishedAt },
      { sourceId: 'b', tier: 2, official: false, title: 'Tesla Powerwall', url: 'https://source-b.test/tesla-powerwall', excerpt: 'Confirmation indépendante.', publishedAt },
    ],
  };
  store.upsertObserved('qualified', 'tesla-risk-after-enrichment', candidate);
  let generated = false;
  const engine = new MediaEngine({
    store,
    env: { MEDIA_ENGINE_X_SEARCH_ENABLED: 'false' },
    enrichCandidateEvidenceImpl: async (value) => ({
      ...value,
      sources: value.sources.map((source) => ({
        ...source,
        excerpt: `${source.excerpt} Une enquête mentionne un rappel pour défaut et risque d'incendie.`,
        evidenceStatus: 'available',
      })),
      evidenceAvailableCount: 2,
    }),
  });
  engine.collect = async () => [];
  engine.researchX = async () => [];
  engine.qualify = () => [];
  engine.generateDraft = async () => { generated = true; return { qa: { passed: true } }; };

  const result = await engine.runCycle({ mediaSlug: 'tesla-tech' });
  assert.equal(generated, false);
  assert.equal(result.drafts.length, 0);
  assert.equal(store.getEvent('draft:tesla-tech:tesla-risk-after-enrichment:news').reason, 'source-officielle-inaccessible');
});

test('cycle: deux sources secondaires qualifiées doivent rester accessibles toutes les deux', async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'media-corroboration-drain-'));
  const store = new MediaStateStore(runtimeDir);
  store.initialize();
  const publishedAt = new Date().toISOString();
  const candidate = {
    id: 'secondary-pair',
    mediaSlug: 'logiciels',
    title: 'Un logiciel SaaS améliore son automatisation marketing',
    primaryUrl: 'https://source-a.test/annonce',
    publishedAt,
    status: 'qualified',
    sources: [
      { sourceId: 'a', tier: 2, official: false, title: 'Logiciel SaaS automatisation', url: 'https://source-a.test/annonce', excerpt: 'Annonce récente.', publishedAt },
      { sourceId: 'b', tier: 2, official: false, title: 'Logiciel SaaS automatisation', url: 'https://source-b.test/annonce', excerpt: 'Confirmation indépendante.', publishedAt },
    ],
  };
  store.upsertObserved('qualified', 'logiciels-secondary-pair', candidate);
  let generated = false;
  const engine = new MediaEngine({
    store,
    env: { MEDIA_ENGINE_X_SEARCH_ENABLED: 'false' },
    enrichCandidateEvidenceImpl: async (value) => ({
      ...value,
      sources: value.sources.map((source, index) => ({ ...source, evidenceStatus: index === 0 ? 'available' : 'unavailable' })),
      evidenceAvailableCount: 1,
    }),
  });
  engine.collect = async () => [];
  engine.researchX = async () => [];
  engine.qualify = () => [];
  engine.generateDraft = async () => { generated = true; return { qa: { passed: true } }; };
  const result = await engine.runCycle({ mediaSlug: 'logiciels' });
  assert.equal(generated, false);
  assert.equal(result.drafts.length, 0);
  assert.equal(store.getEvent('draft:logiciels:secondary-pair:news').reason, 'corroboration-accessible-insuffisante');
});

test('file: un brouillon QA éligible attend sa publication avant une nouvelle génération', () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'media-pending-draft-'));
  const store = new MediaStateStore(runtimeDir);
  store.initialize();
  const banner = join(runtimeDir, 'banner.webp');
  writeFileSync(banner, Buffer.alloc(9_000));
  store.saveDraft('logiciels', {
    candidateId: 'pending',
    contentType: 'news',
    mediaSlug: 'logiciels',
    slug: 'article-en-attente',
    generatedAt: new Date().toISOString(),
    qa: { passed: true },
    publicationEligibility: { status: 'eligible' },
    banner: { path: banner },
  });
  assert.equal(pendingEligibleNewsDraft(store, 'logiciels')?.draft.slug, 'article-en-attente');
  store.markEvent('published:logiciels:news:article-en-attente', { publishedAt: new Date().toISOString() });
  assert.equal(pendingEligibleNewsDraft(store, 'logiciels'), null);
});

test('file: un brouillon actualité de plus de 72 h ne verrouille pas le média', () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'media-stale-pending-draft-'));
  const store = new MediaStateStore(runtimeDir);
  store.initialize();
  store.saveDraft('logiciels', {
    candidateId: 'stale',
    contentType: 'news',
    mediaSlug: 'logiciels',
    slug: 'article-perime',
    generatedAt: '2026-08-01T10:00:00.000Z',
    qa: { passed: true },
    publicationEligibility: { status: 'eligible' },
  });
  assert.equal(pendingEligibleNewsDraft(store, 'logiciels', { now: new Date('2026-08-14T10:00:00.000Z') }), null);
});
