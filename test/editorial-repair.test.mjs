import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARTICLE_THUMBNAIL_POLICY,
  EDITORIAL_REVISION,
  buildBannerPrompt,
  buildEditorialPrompt,
  buildEditorialRepairPrompt,
} from '../media/editorial.mjs';
import { auditDraftOutboundLinks } from '../media/site-publisher.mjs';

const media = {
  name: 'Entreprise et Comptabilité',
  slug: 'entreprise',
  siteUrl: 'https://alexandre-entreprise.fr',
  risk: 'legal-tax',
  editorialBrief: 'Rester factuel.',
  topicKeywords: ['entreprise'],
  newsCategories: ['actualite'],
  guideTopics: ['creation'],
};

const candidate = {
  id: 'candidate-1',
  title: 'Titre vidéo exact',
  score: 80,
  keywordMatches: ['entreprise'],
  sources: [{
    sourceId: 'official',
    official: true,
    tier: 1,
    title: 'Source officielle',
    url: 'https://example.com/source',
    publishedAt: '2026-08-13T08:00:00.000Z',
    excerpt: 'Fait déjà documenté.',
  }],
};

const draft = {
  contentType: 'video',
  section: 'videos',
  title: candidate.title,
  slug: 'titre-video-exact',
  description: 'Description factuelle.',
  body: '## Introduction\n\nFait déjà documenté.',
  wordCount: 6,
  category: 'actualite',
  topic: null,
  tags: ['entreprise'],
  keyPoints: ['Point utile'],
  faq: [],
  sourceUrls: ['https://example.com/source'],
  claims: [{ statement: 'Fait déjà documenté.', sourceRefs: ['S1'] }],
  internalLinkSuggestions: [],
  offer: null,
  bannerBrief: { headline: 'POINT CLÉ', concept: 'Document officiel', alt: 'Document officiel' },
  publicationMode: 'draft',
  generatedAt: '2026-08-13T08:30:00.000Z',
  untrustedRuntimeField: 'ne doit pas être réinjecté',
};

test('éditorial: chaque type vise une marge au-dessus du seuil QA', () => {
  for (const [contentType, target] of [['news', 1_350], ['video', 2_250], ['guide', 3_900]]) {
    const prompt = buildEditorialPrompt({ media, candidate, contentType });
    assert.match(prompt, new RegExp(`vise au moins ${target} mots utiles`));
  }
});

test('réparation éditoriale: le prompt reste borné aux erreurs et au brouillon validé', () => {
  const prompt = buildEditorialRepairPrompt({
    media,
    candidate,
    contentType: 'video',
    draft,
    qa: { issues: [{ code: 'minimum_words', severity: 'error' }] },
  });

  assert.equal(EDITORIAL_REVISION, 13);
  assert.match(prompt, /RÉPARATION QA BORNÉE/);
  assert.match(prompt, /vise au moins 2250 mots utiles/);
  assert.match(prompt, /Le titre doit rester exactement: Titre vidéo exact/);
  assert.match(prompt, /N’ajoute aucun fait, chiffre, citation, test, résultat, offre ou URL/);
  assert.match(prompt, /minimum_words/);
  assert.doesNotMatch(prompt, /untrustedRuntimeField|ne doit pas être réinjecté/);
});

test('miniatures: la réparation ne change ni la politique ni la génération unique', () => {
  const prompt = buildBannerPrompt({ media, draft });
  assert.equal(ARTICLE_THUMBNAIL_POLICY, 'youtube-thumbnail-imagegen:article-single-v2');
  assert.match(prompt, /Crée UNE SEULE miniature/);
  assert.match(prompt, /Ne propose pas de variantes et ne génère pas de deuxième image/);
  assert.match(prompt, /bleu signature #1641A8 dominant/);
  assert.match(prompt, /60–70 % par la couleur de chaîne/);
  assert.match(prompt, /toile de fond principale/);
});

test('publication: AskOptimize est autorisé mais un domaine tiers inconnu reste bloqué', () => {
  const accepted = auditDraftOutboundLinks(
    '[Agence](https://askoptimize.com/audit-seo?utm_source=article)',
    { sourceUrls: [] },
    media,
  );
  assert.equal(accepted.passed, true);

  const rejected = auditDraftOutboundLinks(
    '[Inconnu](https://commercial.example/offre)',
    { sourceUrls: [] },
    media,
  );
  assert.equal(rejected.passed, false);
  assert.deepEqual(rejected.unexpected, ['https://commercial.example/offre']);
});
