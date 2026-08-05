import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  activeMedia,
  MEDIA_NETWORK,
  MEDIA_SOURCES,
  mediaBySlug,
  validateRegistry,
} from '../media/registry.mjs';
import {
  canonicalUrl,
  clusterCandidates,
  qualifyCandidate,
} from '../media/candidates.mjs';
import { collectSource, enrichCandidateEvidence, extractReadableText } from '../media/source-collector.mjs';
import { HermesClient, parseJsonPayload } from '../media/hermes-client.mjs';
import { buildEditorialPrompt, normalizeDraft } from '../media/editorial.mjs';
import { publicationDecision, qaDraft } from '../media/qa.mjs';
import { MediaStateStore } from '../media/state-store.mjs';
import { auditDraftOutboundLinks, formatVideoDuration, renderMdxDraft } from '../media/site-publisher.mjs';
import { resolveTopicId, splitMessage } from '../media/telegram.mjs';
import { guideCandidate, selectGuideOpportunity } from '../media/guide-planner.mjs';
import { publicUrlForDraft, PublicationWorker, siteConfigsFromPayload } from '../media/publication-worker.mjs';
import { MediaEngine } from '../media/engine.mjs';
import { runPreflight } from '../media/preflight.mjs';
import { recommendedPublicationTime } from '../media/publication-schedule.mjs';
import { ytDlpNetworkEnv } from '../lib/whisper.mjs';

test('registre: huit chaînes, six médias éditoriaux et sources officielles', () => {
  assert.deepEqual(validateRegistry(), []);
  assert.equal(MEDIA_NETWORK.length, 8);
  assert.equal(activeMedia().length, 6);
  for (const media of activeMedia()) {
    assert.ok(MEDIA_SOURCES.some((source) => source.media.includes(media.slug) && source.official));
  }
  assert.equal(mediaBySlug('daily').editorialEnabled, false);
  assert.equal(mediaBySlug('askoptimize').editorialEnabled, false);
});

test('transcription YouTube: le proxy protégé est transmis à yt-dlp sans valeur par défaut', () => {
  assert.deepEqual(ytDlpNetworkEnv({ SAFE: 'yes' }), { SAFE: 'yes' });
  const env = ytDlpNetworkEnv({ HTTP_PROXY_URL: '  http://proxy.example:8080  ' });
  assert.equal(env.HTTPS_PROXY, 'http://proxy.example:8080');
  assert.equal(env.https_proxy, 'http://proxy.example:8080');
});

test('collecteur page: ETag, changement et santé sans confondre échec et absence', async () => {
  const response = {
    ok: true,
    status: 200,
    url: 'https://example.test/news',
    headers: new Headers({ 'content-type': 'text/html', etag: 'abc' }),
    text: async () => '<html><head><title>Annonce officielle IA</title><meta name="description" content="Nouveau produit IA pour entreprises"></head></html>',
  };
  const result = await collectSource({
    id: 'official-page',
    name: 'Official',
    type: 'page',
    url: 'https://example.test/news',
    tier: 1,
    official: true,
    media: ['logiciels'],
  }, { fetchImpl: async () => response });
  assert.equal(result.status, 'healthy');
  assert.equal(result.etag, 'abc');
  assert.equal(result.items.length, 1);

  const failed = await collectSource({ id: 'failed', type: 'page', url: 'https://example.test/fail' }, {
    previous: { consecutiveFailures: 2, lastOkAt: '2026-08-01T00:00:00.000Z' },
    fetchImpl: async () => { throw new Error('network down'); },
  });
  assert.equal(failed.status, 'quarantined');
  assert.equal(failed.items.length, 0);
  assert.equal(failed.lastOkAt, '2026-08-01T00:00:00.000Z');
});

test('collecteur officiel: une page index découvre ses articles et enrichit leur preuve', async () => {
  const html = '<html><body><nav><a href="/menu">Un lien de navigation suffisamment long mais ignoré</a></nav><main><a href="/actualites/annonce">L’autorité publie une nouvelle règle pour les entreprises</a><article><p>Cette règle officielle entre en vigueur après une période de transition et précise les obligations applicables aux entreprises concernées. Le texte décrit son calendrier, son périmètre, les personnes visées et les démarches à accomplir. Les modalités présentées ici proviennent directement de la publication de référence.</p></article></main></body></html>';
  assert.doesNotMatch(extractReadableText(html), /navigation suffisamment long/);
  const source = {
    id: 'official-index', name: 'Autorité', type: 'page', pageMode: 'links',
    url: 'https://official.example/actualites', tier: 1, official: true, media: ['entreprise'],
  };
  const response = {
    ok: true, status: 200, url: source.url,
    headers: new Headers({ 'content-type': 'text/html' }), text: async () => html,
  };
  const collected = await collectSource(source, { fetchImpl: async () => response });
  assert.equal(collected.items.length, 1);
  assert.equal(collected.items[0].url, 'https://official.example/actualites/annonce');
  const enriched = await enrichCandidateEvidence({ sources: [{ url: collected.items[0].url }] }, { fetchImpl: async () => response });
  assert.equal(enriched.evidenceAvailableCount, 1);
  assert.match(enriched.sources[0].excerpt, /entre en vigueur/);
});

test('candidats: URL canonique, regroupement et source officielle obligatoire en finance', () => {
  assert.equal(canonicalUrl('https://www.example.com/x/?utm_source=a#b'), 'https://example.com/x');
  const items = [
    {
      id: '1', sourceId: 'amf', sourceTier: 0, sourceOfficial: true,
      title: 'AMF publie une nouvelle alerte sur les crypto-actifs',
      url: 'https://amf.example/alerte', excerpt: 'Alerte officielle crypto',
      publishedAt: new Date().toISOString(), media: ['investissement'],
    },
    {
      id: '2', sourceId: 'media', sourceTier: 2, sourceOfficial: false,
      title: 'Nouvelle alerte AMF concernant les crypto actifs',
      url: 'https://media.example/alerte-amf', excerpt: 'Analyse de la nouvelle alerte',
      publishedAt: new Date().toISOString(), media: ['investissement'],
    },
  ];
  const clusters = clusterCandidates(items, 0.3);
  assert.equal(clusters.length, 1);
  const candidate = qualifyCandidate(clusters[0], mediaBySlug('investissement'));
  assert.equal(candidate.corroborated, true);
  assert.equal(candidate.status, 'qualified');
  assert.ok(candidate.score >= 70);

  const rumor = qualifyCandidate(clusterCandidates([{
    ...items[1],
    id: '3',
    sourceId: 'x-search',
    sourceTier: 3,
    title: 'Rumeur Bitcoin incroyable',
    url: 'https://x.com/example/status/1',
  }])[0], mediaBySlug('investissement'));
  assert.equal(rumor.status, 'rejected');
  assert.ok(rumor.blockers.includes('source-officielle-requise'));
});

test('Hermes: extraction JSON et x_search dégradé sans citation', async () => {
  assert.deepEqual(parseJsonPayload('```json\n{"ok":true}\n```'), { ok: true });
  const calls = [];
  const client = new HermesClient({
    command: ['hermes'],
    env: {},
    executeImpl: async (command, args) => {
      calls.push({ command, args });
      return { stdout: '{"answer":"aucun lien","citations":[],"posts":[],"degraded":false}', stderr: '', code: 0 };
    },
  });
  const result = await client.xSearch({ query: 'test', mediaSlug: 'logiciels' });
  assert.equal(result.degraded, true);
  assert.match(result.degradedReason, /sans citation/);
  assert.ok(calls[0].args.includes('--provider'));
  assert.ok(calls[0].args.includes('openai-codex'));
  assert.ok(calls[0].args.includes('--model'));
  assert.ok(calls[0].args.includes('gpt-5.6-terra'));
});

test('état: idempotence et lease empêchent un double cycle', () => {
  const root = mkdtempSync(join(tmpdir(), 'media-state-'));
  const store = new MediaStateStore(root);
  store.initialize();
  assert.equal(store.hasEvent('article:x'), false);
  store.markEvent('article:x', { ok: true });
  assert.equal(store.hasEvent('article:x'), true);
  const lease = store.acquireLease('cycle');
  assert.ok(lease);
  assert.equal(store.acquireLease('cycle'), null);
  store.releaseLease(lease);
  assert.ok(store.acquireLease('cycle'));
});

test('rédaction: prompt sourcé, QA stricte et activation protégée', () => {
  const media = mediaBySlug('logiciels');
  const candidate = {
    id: 'candidate-1',
    mediaSlug: 'logiciels',
    title: 'GitHub annonce une nouveauté pour les développeurs',
    score: 92,
    status: 'qualified',
    corroborated: true,
    rumor: false,
    keywordMatches: ['logiciel'],
    sources: [{ sourceId: 'github', tier: 0, official: true, title: 'GitHub annonce', url: 'https://github.blog/changelog/item', excerpt: 'Annonce officielle', publishedAt: new Date().toISOString() }],
    offer: null,
  };
  const prompt = buildEditorialPrompt({ media, candidate, contentType: 'news' });
  assert.match(prompt, /SOURCES JSON/);
  assert.match(prompt, /uniquement les faits/);

  const words = Array.from({ length: 1_220 }, (_, index) => `mot${index}`).join(' ');
  const payload = {
    title: 'GitHub améliore son logiciel pour les équipes',
    slug: 'github-ameliore-son-logiciel-pour-les-equipes',
    description: 'GitHub présente une évolution officielle utile aux équipes de développement et aux responsables logiciels.',
    body: `Introduction avec [la source officielle](https://github.blog/changelog/item).\n\n## Ce qui change\n\n${words}`,
    category: 'actualite',
    tags: ['github', 'logiciel'],
    keyPoints: ['Annonce officielle'],
    faq: [],
    sourceUrls: ['https://github.blog/changelog/item'],
    claims: [{ statement: 'GitHub publie une évolution', sourceRefs: ['S1'] }],
    bannerBrief: { alt: 'Interface GitHub illustrant une évolution logicielle' },
  };
  let draft = normalizeDraft(payload, { contentType: 'news', candidate, media });
  const banner = join(mkdtempSync(join(tmpdir(), 'media-banner-')), 'banner.webp');
  writeFileSync(banner, Buffer.alloc(9_000));
  draft = { ...draft, banner: { path: banner, alt: 'Bannière GitHub', width: 1_200, height: 630 } };
  const qa = qaDraft(draft, media, { candidate });
  assert.equal(qa.passed, true, JSON.stringify(qa.issues));
  assert.equal(publicationDecision({ draft, qa, media, publicationMode: 'draft' }).allowed, false);
  assert.equal(publicationDecision({
    draft,
    qa,
    media,
    publicationMode: 'automatic',
    explicitApproval: true,
    shadowDays: 7,
    now: new Date(Date.parse(draft.scheduledPublishAt) + 1),
  }).allowed, true);
});

test('publication: MDX reste brouillon et respecte la collection', () => {
  const media = mediaBySlug('logiciels');
  const mdx = renderMdxDraft({
    title: 'Un nouveau logiciel utile aux entreprises',
    slug: 'nouveau-logiciel-entreprises',
    description: 'Une description suffisamment longue pour respecter le schéma éditorial Astro du site consacré aux logiciels.',
    contentType: 'news',
    body: '## Contenu\n\nTexte.',
    wordCount: 1_200,
    category: 'actualite',
    sourceUrls: ['https://example.test/source'],
  }, media, { coverUrl: 'https://alexandre-logiciels.fr/media-engine/banner.webp' });
  assert.match(mdx, /^---/);
  assert.match(mdx, /^draft: true$/m);
  assert.match(mdx, /^category: "actualite"$/m);
});

test('publication vidéo: la durée YouTube numérique devient une chaîne compatible Astro', () => {
  assert.equal(formatVideoDuration(1_054), '17:34 min');
  assert.equal(formatVideoDuration(3_661), '1:01:01 min');
  assert.equal(formatVideoDuration(0), undefined);
  const media = mediaBySlug('logiciels');
  const mdx = renderMdxDraft({
    title: 'Tutoriel complet du nouveau logiciel marketing',
    slug: 'tutoriel-nouveau-logiciel-marketing',
    description: 'Un tutoriel vidéo détaillé pour comprendre et utiliser ce nouveau logiciel de marketing dans de bonnes conditions.',
    contentType: 'video',
    body: '## Contenu\n\nTexte.',
    wordCount: 2_000,
    category: 'tutoriel',
    tags: [],
    sourceUrls: ['https://www.youtube.com/watch?v=abcdefghijk'],
    video: {
      videoId: 'abcdefghijk',
      title: 'Tutoriel logiciel',
      publishedAt: '2026-08-05T10:00:00.000Z',
      duration: 1_054,
      chapters: [],
    },
  }, media, { coverUrl: 'https://alexandre-logiciels.fr/media-engine/video.jpg' });
  assert.match(mdx, /^duration: "17:34 min"$/m);
});

test('publication: le build ne peut pas injecter une offre commerciale non validée', () => {
  const media = mediaBySlug('logiciels');
  const draft = {
    sourceUrls: ['https://openai.com/index/annonce'],
    offer: { url: 'https://cyberindependant.com/hostinger' },
  };
  const accepted = auditDraftOutboundLinks([
    '[Source](https://openai.com/index/annonce)',
    '[Offre](https://cyberindependant.com/hostinger?utm_source=alexandre-logiciels&utm_medium=article)',
    '[Interne](https://alexandre-logiciels.fr/guides/hebergement)',
  ].join('\n'), draft, media);
  assert.equal(accepted.passed, true);

  const rejected = auditDraftOutboundLinks([
    '[Source](https://openai.com/index/annonce)',
    '[Offre injectée](https://cyberindependant.com/curve?utm_source=alexandre-logiciels)',
  ].join('\n'), draft, media);
  assert.equal(rejected.passed, false);
  assert.deepEqual(rejected.unexpected, ['https://cyberindependant.com/curve?utm_source=alexandre-logiciels']);
});

test('publication: fraîcheur immédiate en journée et report au matin pendant la nuit', () => {
  assert.equal(
    recommendedPublicationTime('news', { now: new Date('2026-08-05T10:00:00.000Z') }).toISOString(),
    '2026-08-05T10:20:00.000Z',
  );
  assert.equal(
    recommendedPublicationTime('news', { now: new Date('2026-08-05T20:30:00.000Z') }).toISOString(),
    '2026-08-06T05:00:00.000Z',
  );
});

test('Telegram: résolution par nom et découpage borné', () => {
  assert.equal(resolveTopicId('🧰 Logiciels & Marketing', { topics: { '🧰 Logiciels & Marketing': 42 } }), 42);
  const chunks = splitMessage('x '.repeat(4_000));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 4_096));
});

test('guide hebdomadaire: demande, offre active et source officielle sont des gates', () => {
  const offers = [{ id: 'qonto', name: 'Qonto', url: 'https://qonto.example/ref', status: 'active', channels: ['entreprise'] }];
  const selected = selectGuideOpportunity([{
    id: 'facturation-2026',
    mediaSlug: 'entreprise',
    title: 'Guide complet de la facturation électronique',
    offerId: 'qonto',
    priorityScore: 90,
    demandEvidence: { gscImpressions: 300 },
    sources: [{ id: 'service-public', url: 'https://entreprendre.service-public.fr/actualites/A15683', official: true, title: 'Facturation électronique' }],
  }], 'entreprise', offers);
  assert.equal(selected.eligible, true);
  const candidate = guideCandidate(selected, mediaBySlug('entreprise'));
  assert.equal(candidate.status, 'qualified');
  assert.equal(candidate.offer.id, 'qonto');

  const blocked = selectGuideOpportunity([{ id: 'sans-preuve', mediaSlug: 'entreprise', title: 'Guide', offerId: 'qonto', sources: [] }], 'entreprise', offers);
  assert.equal(blocked.eligible, false);
  assert.ok(blocked.blockers.includes('demande-non-prouvée'));
});

test('publication VPS: URL, période d’observation, autorisation et push sont quatre gates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-publication-'));
  const store = new MediaStateStore(root);
  store.initialize();
  const media = mediaBySlug('logiciels');
  const draft = {
    mediaSlug: 'logiciels',
    contentType: 'news',
    publicationMode: 'draft',
    slug: 'nouvelle-version-logiciel',
    title: 'Une nouvelle version du logiciel est disponible',
    qa: { passed: true },
  };
  const path = store.saveDraft('logiciels', { ...draft, candidateId: 'publication-test' });
  const sites = siteConfigsFromPayload({
    logiciels: { repository: 'git@github.com:Aldrenax/alexandre-logiciels.git', branch: 'main' },
  });
  assert.equal(publicUrlForDraft(media, draft), 'https://alexandre-logiciels.fr/actualites/nouvelle-version-logiciel');

  const blocked = new PublicationWorker({
    store,
    siteConfigs: sites,
    env: { MEDIA_ENGINE_PUBLICATION_MODE: 'draft' },
  });
  const blockedResult = await blocked.publishDraftPath(path, { dryRun: true });
  assert.equal(blockedResult.allowed, false);
  assert.ok(blockedResult.decision.blockers.includes('publication-mode-not-automatic'));
  assert.ok(blockedResult.decision.blockers.includes('git-push-disabled'));

  const allowed = new PublicationWorker({
    store,
    siteConfigs: sites,
    env: {
      MEDIA_ENGINE_PUBLICATION_MODE: 'automatic',
      MEDIA_ENGINE_AUTOMATIC_PUBLICATION_APPROVED: 'true',
      MEDIA_ENGINE_PUSH_ENABLED: 'true',
      MEDIA_ENGINE_SHADOW_STARTED_AT: '2026-07-01T00:00:00.000Z',
    },
    now: () => new Date('2026-08-05T00:00:00.000Z'),
  });
  const allowedResult = await allowed.publishDraftPath(path, { dryRun: true });
  assert.equal(allowedResult.allowed, true);
});

test('supervision: un état jamais observé crée une seule alerte explicite par jour', () => {
  const root = mkdtempSync(join(tmpdir(), 'media-monitor-'));
  const store = new MediaStateStore(root);
  const engine = new MediaEngine({ store });
  const first = engine.monitor();
  assert.equal(first.health.status, 'degraded');
  assert.ok(first.health.blockers.includes('source-health-unobserved'));
  assert.equal(store.listDraftPaths().length, 0);
  const eventsDirectory = join(root, 'queue', 'events');
  const eventFiles = readdirSync(eventsDirectory);
  assert.equal(eventFiles.length, 1);
  engine.monitor();
  assert.equal(readdirSync(eventsDirectory).length, 1);
});

test('préflight: ChatGPT, topics et dépôts sont requis, xAI reste un enrichissement visible', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-preflight-'));
  const topicStatePath = join(root, 'topics.json');
  const systemTopics = ['✅ Décisions à valider', '🚨 Santé & incidents', '📊 Cockpit réseau', '✍️ Pilotage'];
  writeFileSync(topicStatePath, JSON.stringify({
    topics: Object.fromEntries([...activeMedia().map((media) => media.topicName), ...systemTopics].map((name, index) => [name, index + 1])),
  }));
  const siteConfigs = Object.fromEntries(activeMedia().map((media) => [media.slug, {
    repository: `git@github.com:Aldrenax/${media.slug}.git`,
    branch: 'main',
  }]));
  const ready = await runPreflight({
    hermes: {
      authList: async () => ({ raw: 'xai-oauth\nopenai-codex', providers: ['xai-oauth', 'openai-codex'] }),
      toolList: async () => '✓ enabled  image_gen  Image Generation',
      configGet: async () => 'gpt-image-2',
    },
    topicStatePath,
    siteConfigs,
    env: { MEDIA_ENGINE_PUBLICATION_MODE: 'draft' },
  });
  assert.equal(ready.readyForShadow, true);
  assert.equal(ready.readyForFullResearch, true);
  assert.equal(ready.readyForPublishing, false);

  const blocked = await runPreflight({
    hermes: {
      authList: async () => ({ raw: 'openai-codex', providers: ['openai-codex'] }),
      toolList: async () => '✓ enabled  image_gen  Image Generation',
      configGet: async () => 'gpt-image-2',
    },
    topicStatePath,
    siteConfigs,
    env: { MEDIA_ENGINE_PUBLICATION_MODE: 'draft' },
  });
  assert.equal(blocked.readyForShadow, true);
  assert.equal(blocked.readyForFullResearch, false);
  assert.equal(blocked.enrichmentChecks.find((entry) => entry.id === 'xai-oauth').passed, false);
});

test('recherche X: une panne Grok dégrade l’enrichissement sans interrompre le cycle RSS', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-x-degraded-'));
  let xSearchCalls = 0;
  const engine = new MediaEngine({
    store: new MediaStateStore(root),
    hermes: {
      authList: async () => ({ raw: 'openai-codex', providers: ['openai-codex'] }),
      xSearch: async () => {
        xSearchCalls += 1;
        throw new Error('xai-oauth absent');
      },
    },
  });
  const results = await engine.researchX({ mediaSlug: 'logiciels' });
  assert.equal(results.length, 3);
  assert.ok(results.every((result) => result.degraded));
  assert.ok(results.every((result) => result.degradedReason === 'xai-oauth absent'));
  assert.equal(xSearchCalls, 0);
  const health = engine.healthReport({
    collectionResults: [{ sourceId: 'official', required: true, status: 'healthy' }],
    xResults: results,
  });
  assert.equal(health.status, 'degraded');
  assert.deepEqual(health.blockers, []);
  assert.ok(health.warnings.includes('x-search-unavailable'));
});
