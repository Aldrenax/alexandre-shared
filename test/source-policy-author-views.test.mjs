import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MEDIA_SOURCES } from '../config/media-network.mjs';
import { SOURCE_POLICY_AUTHOR_VIEWS } from '../config/source-policies.mjs';
import { clusterCandidates } from '../media/candidates.mjs';
import { buildEditorialPrompt } from '../media/editorial.mjs';
import { buildQualifiedCandidatePool, MediaEngine, qaCanBeRepaired } from '../media/engine.mjs';
import { qaDraft } from '../media/qa.mjs';
import { mediaBySlug } from '../media/registry.mjs';
import { collectSource } from '../media/source-collector.mjs';
import { MediaStateStore } from '../media/state-store.mjs';

const SOURCE_URL = 'https://www.ecb.europa.eu/press/blog/date/2026/html/ecb.blog20260901~example.en.html';
const PRESS_URL = 'https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.pr20260901~example.fr.html';
const PUBLISHED_AT = '2026-09-01T07:00:00.000Z';

function authorViewsCandidate() {
  return {
    id: 'ecb-blog-inflation-energy',
    mediaSlug: 'investissement',
    title: 'Inflation et choc énergétique en zone euro',
    primaryUrl: SOURCE_URL,
    publishedAt: PUBLISHED_AT,
    status: 'qualified',
    corroborated: true,
    rumor: false,
    score: 78,
    keywordMatches: ['inflation'],
    sources: [{
      sourceId: 'ecb-blog',
      tier: 0,
      official: true,
      sourcePolicy: SOURCE_POLICY_AUTHOR_VIEWS,
      author: 'Anna Auteur et Bruno Auteur',
      title: 'Inflation and the energy shock',
      url: SOURCE_URL,
      excerpt: 'The authors analyse how an energy shock can affect inflation.',
      publishedAt: PUBLISHED_AT,
      kind: 'news',
    }],
  };
}

function financeDraft({ title, analysis, claims }) {
  return {
    candidateId: 'ecb-blog-inflation-energy',
    contentType: 'news',
    section: 'actualites',
    title,
    slug: 'inflation-choc-energetique-auteurs-bce',
    description: 'Analyse sourcée du choc énergétique et de ses effets possibles sur l’inflation en zone euro.',
    body: [
      analysis,
      `[Lire le billet signé publié sur le site de la BCE](${SOURCE_URL}).`,
      'Ce contenu ne constitue pas un conseil en investissement.',
      'Tout investissement comporte un risque de perte en capital, partielle ou totale.',
    ].join('\n\n'),
    wordCount: 1_200,
    category: 'analyse',
    sourceUrls: [SOURCE_URL],
    claims,
  };
}

test('source author-views: la politique BCE Blog traverse collecte et candidate.sources', async () => {
  const source = MEDIA_SOURCES.find((entry) => entry.id === 'ecb-blog');
  assert.equal(source.sourcePolicy, SOURCE_POLICY_AUTHOR_VIEWS);
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel><title>ECB Blog</title><link>https://www.ecb.europa.eu/</link>
      <item><title>Inflation and the energy shock</title><link>${SOURCE_URL}</link>
        <guid>${SOURCE_URL}</guid><author>Anna Auteur et Bruno Auteur</author>
        <description>The authors analyse how an energy shock can affect inflation.</description>
        <pubDate>Tue, 01 Sep 2026 07:00:00 GMT</pubDate></item>
    </channel></rss>`;
  const response = new Response(rss, {
    status: 200,
    headers: { 'content-type': 'application/rss+xml' },
  });
  const collected = await collectSource(source, { fetchImpl: async () => response });
  assert.equal(collected.items[0].sourcePolicy, SOURCE_POLICY_AUTHOR_VIEWS);
  assert.equal(collected.items[0].author, 'Anna Auteur et Bruno Auteur');

  const candidate = clusterCandidates(collected.items)[0];
  assert.equal(candidate.sources[0].sourcePolicy, SOURCE_POLICY_AUTHOR_VIEWS);
  assert.equal(candidate.sources[0].author, 'Anna Auteur et Bruno Auteur');
});

test('source author-views: une ancienne file mono-source récupère la politique à la requalification', () => {
  const legacy = authorViewsCandidate();
  delete legacy.sources[0].sourcePolicy;
  const pool = buildQualifiedCandidatePool({
    queueEntries: [{ payload: legacy }],
    media: [mediaBySlug('investissement')],
    now: new Date('2026-09-01T09:00:00.000Z'),
  });
  assert.equal(pool.length, 1);
  assert.equal(pool[0].sources[0].sourcePolicy, SOURCE_POLICY_AUTHOR_VIEWS);
});

test('source author-views: le prompt transporte auteurs, politique et réserve obligatoire', () => {
  const prompt = buildEditorialPrompt({
    media: mediaBySlug('investissement'),
    candidate: authorViewsCandidate(),
    contentType: 'news',
  });
  assert.match(prompt, /"sourcePolicy":"author-views"/u);
  assert.match(prompt, /"author":"Anna Auteur et Bruno Auteur"/u);
  assert.match(prompt, /analyse de ses auteurs/u);
  assert.match(prompt, /ne constitue pas une position officielle de la BCE/u);
  assert.match(prompt, /Ne les attribue jamais à la BCE comme position institutionnelle/u);
});

test('source author-views: l’ancien brouillon attribué à la BCE est rejeté', () => {
  const draft = financeDraft({
    title: 'Inflation 2026 : pourquoi la BCE pointe le choc énergétique',
    analysis: 'La BCE estime que le choc énergétique explique la trajectoire récente de l’inflation.',
    claims: [{ statement: 'La BCE attribue cette trajectoire au choc énergétique.', sourceRefs: ['S1'] }],
  });
  const qa = qaDraft(draft, mediaBySlug('investissement'), {
    candidate: authorViewsCandidate(),
    requireBanner: false,
  });
  assert.equal(qa.passed, false);
  assert.ok(qa.issues.some((entry) => entry.code === 'author-views-institutional-attribution'));
  assert.ok(qa.issues.some((entry) => entry.code === 'author-views-attribution-missing'));
  assert.ok(qa.issues.some((entry) => entry.code === 'author-views-reserve-missing'));
});

test('source author-views: attribution aux économistes et réserve explicite sont acceptées', () => {
  const draft = financeDraft({
    title: 'Inflation : deux économistes de la BCE analysent le choc énergétique',
    analysis: [
      'Deux économistes de la BCE analysent les mécanismes possibles dans un billet signé.',
      'Cette analyse reflète le point de vue de ses auteurs et ne constitue pas une position officielle de la BCE.',
    ].join(' '),
    claims: [{ statement: 'Deux économistes de la BCE relient le choc énergétique à certains mécanismes inflationnistes.', sourceRefs: ['S1'] }],
  });
  const qa = qaDraft(draft, mediaBySlug('investissement'), {
    candidate: authorViewsCandidate(),
    requireBanner: false,
  });
  assert.equal(qa.passed, true, JSON.stringify(qa.issues));
});

test('source author-views: le canari accepte les auteurs comme attribution locale des claims analytiques', () => {
  const draft = financeDraft({
    title: 'Inflation : deux économistes de la BCE analysent le choc énergétique',
    analysis: [
      'Deux économistes de la BCE analysent les mécanismes possibles dans un billet signé.',
      'Cette analyse reflète le point de vue de ses auteurs et ne constitue pas une position officielle de la BCE.',
    ].join(' '),
    claims: [
      { statement: 'Les auteurs estiment que le choc énergétique entretient certains mécanismes inflationnistes.', sourceRefs: ['S1'] },
      { statement: 'Les chercheurs attribuent une partie de la trajectoire récente aux prix de l’énergie.', sourceRefs: ['S1'] },
    ],
  });
  const qa = qaDraft(draft, mediaBySlug('investissement'), {
    candidate: authorViewsCandidate(),
    requireBanner: false,
  });
  assert.equal(qa.passed, true, JSON.stringify(qa.issues));
  assert.ok(!qa.issues.some((entry) => entry.code === 'author-views-attribution-missing'));
});

test('source author-views: les alias institutionnels et une réserve approchante sont rejetés', () => {
  const rejected = financeDraft({
    title: 'Inflation : deux économistes de la BCE analysent le choc énergétique',
    analysis: [
      'Deux économistes de la BCE signent le billet.',
      'La banque centrale précise que le choc explique la hausse.',
      'Les opinions ne représentent pas nécessairement la position de la BCE.',
    ].join(' '),
    claims: [{ statement: 'La banque centrale indique que l’énergie domine.', sourceRefs: ['S1'] }],
  });
  const rejectedQa = qaDraft(rejected, mediaBySlug('investissement'), {
    candidate: authorViewsCandidate(),
    requireBanner: false,
  });
  assert.equal(rejectedQa.passed, false);
  assert.ok(rejectedQa.issues.some((entry) => entry.code === 'author-views-institutional-attribution'));
  assert.ok(rejectedQa.issues.some((entry) => entry.code === 'author-views-reserve-missing'));
});

test('source author-views: la réserve exacte ne remplace pas l’attribution des conclusions analytiques', () => {
  const draft = financeDraft({
    title: 'Inflation et choc énergétique en zone euro',
    analysis: [
      'Le choc énergétique explique une partie des mécanismes inflationnistes décrits dans le billet.',
      'Cette analyse reflète le point de vue de ses auteurs et ne constitue pas une position officielle de la BCE.',
    ].join(' '),
    claims: [{ statement: 'Le choc énergétique explique une partie des mécanismes inflationnistes.', sourceRefs: ['S1'] }],
  });
  const qa = qaDraft(draft, mediaBySlug('investissement'), {
    candidate: authorViewsCandidate(),
    requireBanner: false,
  });
  assert.equal(qa.passed, false);
  assert.ok(qa.issues.some((entry) => entry.code === 'author-views-attribution-missing'));
  assert.ok(!qa.issues.some((entry) => entry.code === 'author-views-reserve-missing'));
});

test('source author-views: les claims factuelles de publication ou de méthode ne doivent pas répéter les auteurs', () => {
  const draft = financeDraft({
    title: 'Une méthode publiée dans le blog de la BCE',
    analysis: 'Cette analyse reflète le point de vue de ses auteurs et ne constitue pas une position officielle de la BCE.',
    claims: [
      { statement: 'Le billet a été publié le 1er septembre 2026.', sourceRefs: ['S1'] },
      { statement: 'La méthode couvre la période 2020 à 2025.', sourceRefs: ['S1'] },
    ],
  });
  const qa = qaDraft(draft, mediaBySlug('investissement'), {
    candidate: authorViewsCandidate(),
    requireBanner: false,
  });
  assert.equal(qa.passed, true, JSON.stringify(qa.issues));
});

test('source author-views: les formulations institutionnelles sont contrôlées dans tous les champs publics', () => {
  const base = financeDraft({
    title: 'Inflation : deux économistes analysent le choc énergétique',
    analysis: [
      'Deux économistes de la BCE analysent les mécanismes possibles dans un billet signé.',
      'Cette analyse reflète le point de vue de ses auteurs et ne constitue pas une position officielle de la BCE.',
    ].join(' '),
    claims: [{ statement: 'Deux économistes de la BCE relient le choc énergétique à certains mécanismes inflationnistes.', sourceRefs: ['S1'] }],
  });
  const phrase = 'Pour la BCE, le choc énergétique domine.';
  const variants = [
    { name: 'description', draft: { ...base, description: phrase } },
    { name: 'tags', draft: { ...base, tags: [phrase] } },
    { name: 'keyPoints', draft: { ...base, keyPoints: [phrase] } },
    { name: 'faq', draft: { ...base, faq: [{ question: phrase, answer: 'Réponse.' }] } },
    { name: 'internalLinkSuggestions', draft: { ...base, internalLinkSuggestions: [{ anchor: phrase, path: '/inflation/' }] } },
    { name: 'bannerBrief', draft: { ...base, bannerBrief: { headline: phrase, concept: 'Énergie', alt: 'Énergie' } } },
    { name: 'banner.alt', draft: { ...base, banner: { alt: phrase } } },
  ];
  for (const variant of variants) {
    const qa = qaDraft(variant.draft, mediaBySlug('investissement'), {
      candidate: authorViewsCandidate(),
      requireBanner: false,
    });
    assert.ok(
      qa.issues.some((entry) => entry.code === 'author-views-institutional-attribution'),
      `${variant.name}: ${JSON.stringify(qa.issues)}`,
    );
  }
});

test('source author-views: une claim institutionnelle reste permise si elle référence uniquement un communiqué distinct', () => {
  const candidate = authorViewsCandidate();
  candidate.sources.push({
    sourceId: 'ecb-press',
    tier: 0,
    official: true,
    sourcePolicy: null,
    author: 'Banque centrale européenne',
    title: 'Décision de politique monétaire',
    url: PRESS_URL,
    excerpt: 'La BCE maintient ses taux directeurs.',
    publishedAt: PUBLISHED_AT,
    kind: 'news',
  });
  const pressStatement = 'Dans un communiqué distinct, la BCE affirme maintenir ses taux directeurs.';
  const draft = financeDraft({
    title: 'Inflation et décision monétaire en zone euro',
    analysis: [
      'Deux économistes de la BCE analysent les mécanismes du choc dans un billet signé.',
      'Cette analyse reflète le point de vue de ses auteurs et ne constitue pas une position officielle de la BCE.',
      pressStatement,
      `[Lire le communiqué institutionnel](${PRESS_URL}).`,
    ].join(' '),
    claims: [
      { statement: 'Deux économistes de la BCE relient le choc à certains mécanismes inflationnistes.', sourceRefs: ['S1'] },
      { statement: pressStatement, sourceRefs: ['S2'] },
    ],
  });
  draft.sourceUrls.push(PRESS_URL);
  const accepted = qaDraft(draft, mediaBySlug('investissement'), { candidate, requireBanner: false });
  assert.equal(accepted.passed, true, JSON.stringify(accepted.issues));

  const wrongSource = {
    ...draft,
    claims: [draft.claims[0], { ...draft.claims[1], sourceRefs: ['S1'] }],
  };
  const rejected = qaDraft(wrongSource, mediaBySlug('investissement'), { candidate, requireBanner: false });
  assert.equal(rejected.passed, false);
  assert.ok(rejected.issues.some((entry) => entry.code === 'author-views-institutional-attribution'));
});

test('source author-views: une négation explicite ne devient pas un faux positif institutionnel', () => {
  const draft = financeDraft({
    title: 'Inflation et prudence d’attribution',
    analysis: [
      'Deux économistes de la BCE analysent les mécanismes possibles dans un billet signé.',
      'Il serait erroné de dire que la BCE estime avoir arrêté une position institutionnelle.',
      'Cette analyse reflète le point de vue de ses auteurs et ne constitue pas une position officielle de la BCE.',
    ].join(' '),
    claims: [{ statement: 'Deux économistes de la BCE relient le choc à certains mécanismes inflationnistes.', sourceRefs: ['S1'] }],
  });
  const qa = qaDraft(draft, mediaBySlug('investissement'), {
    candidate: authorViewsCandidate(),
    requireBanner: false,
  });
  assert.equal(qa.passed, true, JSON.stringify(qa.issues));
});

test('source author-views: les trois erreurs déclenchent une réparation bornée', async () => {
  for (const code of [
    'author-views-institutional-attribution',
    'author-views-attribution-missing',
    'author-views-reserve-missing',
  ]) {
    assert.equal(qaCanBeRepaired({ issues: [{ code, severity: 'error' }] }), true, code);
  }

  const root = mkdtempSync(join(tmpdir(), 'author-views-repair-'));
  const thumbnailPath = join(root, 'thumbnail.jpg');
  writeFileSync(thumbnailPath, Buffer.alloc(12_000, 1));
  const candidate = authorViewsCandidate();
  const payload = (repaired) => ({
    title: candidate.title,
    slug: 'inflation-et-choc-energetique-en-zone-euro',
    description: 'Une analyse détaillée des mécanismes inflationnistes présentés dans le billet signé.',
    body: [
      repaired
        ? 'Deux économistes de la BCE relient le choc énergétique à certains mécanismes inflationnistes.'
        : 'Pour la BCE, le choc énergétique domine la trajectoire récente.',
      repaired ? 'Cette analyse reflète le point de vue de ses auteurs et ne constitue pas une position officielle de la BCE.' : '',
      `[Lire le billet signé](${SOURCE_URL}).`,
      'Ce contenu ne constitue pas un conseil en investissement.',
      'Tout investissement comporte un risque de perte en capital, partielle ou totale.',
      'Contexte utile '.repeat(2_100),
    ].filter(Boolean).join('\n\n'),
    sourceUrls: [SOURCE_URL],
    claims: [{
      statement: repaired
        ? 'Deux économistes de la BCE relient le choc énergétique à certains mécanismes inflationnistes.'
        : 'Le choc énergétique explique la trajectoire récente de l’inflation.',
      sourceRefs: ['S1'],
    }],
  });
  const prompts = [];
  const engine = new MediaEngine({
    store: new MediaStateStore(root),
    env: { MEDIA_ENGINE_QA_REPAIR_ATTEMPTS: '1' },
    hermes: {
      generateEditorialJson: async (prompt) => {
        prompts.push(prompt);
        return payload(prompts.length > 1);
      },
    },
  });
  const draft = await engine.generateDraft(candidate, {
    contentType: 'video',
    video: { videoId: 'authorViewsRepair', title: candidate.title, thumbnailPath, thumbnailAlt: candidate.title },
    generateBanner: false,
  });

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /POLITIQUE SOURCE SIGNÉE OBLIGATOIRE/u);
  assert.equal(draft.qa.passed, true, JSON.stringify(draft.qa.issues));
  assert.equal(draft.qa.version, 2);
  assert.equal(draft.qaRepair.attempts, 1);
  assert.equal(draft.qaRepair.resolved, true);
  assert.ok(draft.qaRepair.initialIssueCodes.includes('author-views-institutional-attribution'));
  assert.ok(draft.qaRepair.initialIssueCodes.includes('author-views-attribution-missing'));
  assert.ok(draft.qaRepair.initialIssueCodes.includes('author-views-reserve-missing'));
});
