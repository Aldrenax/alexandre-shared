import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
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
  findDraftConflict,
  findInternalLinkConflict,
  qualifyCandidate,
} from '../media/candidates.mjs';
import { curateDraftQueue } from '../media/draft-curation.mjs';
import { collectSource, enrichCandidateEvidence, extractBalancedEvidence, extractReadableText } from '../media/source-collector.mjs';
import { defaultHermesCommand, HermesClient, parseJsonPayload } from '../media/hermes-client.mjs';
import { buildEditorialPrompt, normalizeDraft } from '../media/editorial.mjs';
import { publicationDecision, qaDraft } from '../media/qa.mjs';
import { MediaStateStore } from '../media/state-store.mjs';
import { auditDraftOutboundLinks, formatVideoDuration, renderMdxDraft } from '../media/site-publisher.mjs';
import { resolveTopicId, splitMessage } from '../media/telegram.mjs';
import { guideCandidate, selectGuideOpportunity } from '../media/guide-planner.mjs';
import { publicUrlForDraft, PublicationWorker, siteConfigsFromPayload } from '../media/publication-worker.mjs';
import {
  downloadFirstAvailableAsset,
  materializeBanner,
  MediaEngine,
  offerForUrl,
  publishedVideoPath,
  shouldGenerateDraftForEvent,
} from '../media/engine.mjs';
import { runPreflight } from '../media/preflight.mjs';
import { recommendedPublicationTime } from '../media/publication-schedule.mjs';
import {
  readCachedTranscript, runYtDlpWithRetries, stickyProxyUrl, writeCachedTranscript, ytDlpNetworkEnv,
} from '../lib/whisper.mjs';
import { getChannelFeed, getChannelFeedWithYtDlp, resolveVideoMetadata, youtubeThumbnailCandidates } from '../lib/youtube.mjs';

test('registre: huit chaînes, six médias éditoriaux et sources officielles', () => {
  assert.deepEqual(validateRegistry(), []);
  assert.equal(MEDIA_NETWORK.length, 8);
  assert.equal(activeMedia().length, 6);
  for (const media of activeMedia()) {
    assert.ok(MEDIA_SOURCES.some((source) => source.media.includes(media.slug) && source.official));
    assert.ok(media.editorialBrief.length > 200);
  }
  assert.equal(mediaBySlug('daily').editorialEnabled, false);
  assert.equal(mediaBySlug('askoptimize').editorialEnabled, false);
});

test('transcription YouTube: le proxy protégé est transmis à yt-dlp sans valeur par défaut', () => {
  assert.deepEqual(ytDlpNetworkEnv({ SAFE: 'yes' }), { SAFE: 'yes' });
  const env = ytDlpNetworkEnv({ HTTP_PROXY_URL: '  http://proxy.example:8080  ' }, 'abcd1234');
  assert.equal(env.HTTPS_PROXY, 'http://proxy.example:8080/');
  assert.equal(env.https_proxy, 'http://proxy.example:8080/');
  const sticky = stickyProxyUrl('http://user:password@geo.iproyal.com:12321', 'abcd1234');
  assert.match(sticky, /password_session-abcd1234_lifetime-2h/);
  assert.equal(stickyProxyUrl(sticky, 'wxyz5678'), sticky);
});

test('transcription YouTube: chaque reprise renouvelle la session proxy', async () => {
  const attempts = [];
  const result = await runYtDlpWithRetries(['--version'], {
    attempts: 3,
    env: { HTTP_PROXY_URL: 'http://user:password@geo.iproyal.com:12321' },
    waitImpl: async () => {},
    runImpl: async (_command, _args, options) => {
      attempts.push(options.env.HTTPS_PROXY);
      if (attempts.length < 3) throw new Error('504 Gateway Timeout');
      return { stdout: 'ok', stderr: '' };
    },
  });
  assert.equal(result.stdout, 'ok');
  assert.equal(attempts.length, 3);
  assert.equal(new Set(attempts).size, 3);
});

test('transcription YouTube: après un proxy en échec, le réseau direct est essayé par défaut', async () => {
  const plans = [];
  const result = await runYtDlpWithRetries(['--version'], {
    attempts: 1,
    env: { HTTP_PROXY_URL: 'http://user:password@geo.iproyal.com:12321' },
    waitImpl: async () => {},
    runImpl: async (_command, _args, options) => {
      plans.push(Boolean(options.env.HTTPS_PROXY));
      if (plans.length === 1) throw new Error('proxy timeout');
      return { stdout: 'ok', stderr: '' };
    },
  });
  assert.equal(result.stdout, 'ok');
  assert.deepEqual(plans, [true, false]);
});

test('transcription YouTube: un résultat complet est conservé dans le cache local', () => {
  const root = mkdtempSync(join(tmpdir(), 'whisper-cache-'));
  const env = { WHISPER_TRANSCRIPT_CACHE_DIR: root };
  const transcript = 'transcription '.repeat(50);
  assert.ok(writeCachedTranscript('dzQLM3agA_o', transcript, env));
  assert.equal(readCachedTranscript('dzQLM3agA_o', env), transcript.trim());
});

test('métadonnées YouTube: yt-dlp prévaut pour détecter un Short et sa miniature', () => {
  const metadata = resolveVideoMetadata(
    { duration: 120, thumbnail: [{ width: 120, height: 90 }] },
    { duration: 37, thumbnails: [{ url: 'https://i.ytimg.com/short.jpg', width: 720, height: 1280 }] },
  );
  assert.equal(metadata.duration, 37);
  assert.equal(metadata.isShort, true);
  assert.equal(metadata.thumbnails[0].url, 'https://i.ytimg.com/short.jpg');
});

test('miniature YouTube: le CDN standard prend le relais si les métadonnées sont vides', async () => {
  const videoId = 'dzQLM3agA_o';
  const candidates = youtubeThumbnailCandidates(videoId, []);
  assert.match(candidates[0].url, /maxresdefault\.jpg$/);
  assert.match(candidates[1].url, /hqdefault\.jpg$/);
  const root = mkdtempSync(join(tmpdir(), 'youtube-thumbnail-'));
  const destination = join(root, 'thumbnail.jpg');
  const requested = [];
  const selected = await downloadFirstAvailableAsset(candidates, destination, async (url) => {
    requested.push(url);
    if (url.endsWith('/maxresdefault.jpg')) return new Response('', { status: 404 });
    return new Response(Buffer.alloc(12_000, 1), { status: 200 });
  });
  assert.match(selected.url, /hqdefault\.jpg$/);
  assert.equal(requested.length, 2);
});

test('flux YouTube: yt-dlp prend le relais après un RSS 404 et une chaîne vide reste saine', async () => {
  const calls = [];
  const fallback = async (channelId) => {
    calls.push(channelId);
    return [{ videoId: 'fallback-1', title: 'Vidéo récupérée', link: 'https://www.youtube.com/watch?v=fallback-1', pubDate: new Date('2026-08-06T00:00:00Z') }];
  };
  const feed = await getChannelFeed('UC-fallback', {
    fetchImpl: async () => new Response('', { status: 404 }),
    ytDlpFeedImpl: fallback,
  });
  assert.equal(feed[0].videoId, 'fallback-1');
  assert.deepEqual(calls, ['UC-fallback']);

  const empty = await getChannelFeed('UC-empty', {
    fetchImpl: async () => new Response('', { status: 404 }),
    ytDlpFeedImpl: async () => [],
  });
  assert.deepEqual(empty, []);

  const noVideosTab = await getChannelFeedWithYtDlp('UC-empty-tab', {
    execFileImpl: async () => { throw Object.assign(new Error('yt-dlp exit 1'), { stderr: 'This channel does not have a videos tab' }); },
  });
  assert.deepEqual(noVideosTab, []);
});

test('bannière Hermes: un chemin conteneur est résolu uniquement dans le cache autorisé', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-image-cache-'));
  const cache = join(root, 'cache', 'images');
  mkdirSync(cache, { recursive: true });
  const source = join(cache, 'generated.png');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#123456"/><desc>${'preuve'.repeat(1_500)}</desc></svg>`;
  writeFileSync(source, svg);
  const destination = join(root, 'assets', 'banner.webp');

  await materializeBanner('/opt/data/cache/images/generated.png', destination, fetch, {
    hermesHostImageRoot: cache,
  });
  assert.equal(existsSync(destination), true);

  await assert.rejects(
    materializeBanner('/etc/passwd', join(root, 'assets', 'invalid.webp'), fetch, { hermesHostImageRoot: cache }),
    /hors cache Hermes/,
  );
});

test('affiliation vidéo: le chemin Pretty Link exact prévaut sur le domaine partagé', () => {
  const offers = [
    { id: 'boursobank', status: 'active', channels: ['investissement'], url: 'https://cyberindependant.com/boursorama' },
    { id: 'deblock', status: 'active', channels: ['investissement'], url: 'https://cyberindependant.com/deblock' },
  ];
  assert.equal(offerForUrl(offers, 'investissement', 'https://cyberindependant.com/deblock/').id, 'deblock');
  assert.equal(offerForUrl(offers, 'investissement', 'https://cyberindependant.com/inconnu'), null);
});

test('cycle vidéo: un Short RSS est écarté avant toute métadonnée coûteuse', async () => {
  let infoCalls = 0;
  const engine = new MediaEngine({
    store: new MediaStateStore(mkdtempSync(join(tmpdir(), 'media-video-short-'))),
    getChannelFeedImpl: async () => [
      { videoId: 'short-1', link: 'https://www.youtube.com/shorts/short-1', title: 'Short' },
      { videoId: 'long-1', link: 'https://www.youtube.com/watch?v=long-1', title: 'Longue vidéo' },
    ],
    getVideoInfoImpl: async () => { infoCalls += 1; return {}; },
  });
  const result = await engine.runVideoCycle({ mediaSlug: 'investissement', dryRun: true });
  assert.equal(result[0].planned, true);
  assert.equal(result[0].video.videoId, 'long-1');
  assert.equal(result[0].ignoredShorts, 1);
  assert.equal(infoCalls, 0);
});

test('cycle vidéo: une page existante empêche de recréer un brouillon du backlog', async () => {
  assert.equal(
    publishedVideoPath([{ path: '/videos/2026-06-12-laver-tesla-ryhf3foxqze/' }], 'ryHF3fOxQzE'),
    '/videos/2026-06-12-laver-tesla-ryhf3foxqze/',
  );
  const engine = new MediaEngine({
    store: new MediaStateStore(mkdtempSync(join(tmpdir(), 'media-video-published-'))),
    internalLinks: {
      'tesla-tech': [{ path: '/videos/2026-06-12-laver-tesla-ryhf3foxqze/' }],
    },
    getChannelFeedImpl: async () => [
      { videoId: 'ryHF3fOxQzE', link: 'https://www.youtube.com/watch?v=ryHF3fOxQzE', title: 'Déjà publiée' },
      { videoId: 'newVideo123', link: 'https://www.youtube.com/watch?v=newVideo123', title: 'Nouvelle vidéo' },
    ],
  });
  const result = await engine.runVideoCycle({ mediaSlug: 'tesla-tech', dryRun: true });
  assert.equal(result[0].planned, true);
  assert.equal(result[0].video.videoId, 'newVideo123');
});

test('cycle vidéo: une panne est isolée et reçoit un délai de reprise', async () => {
  const store = new MediaStateStore(mkdtempSync(join(tmpdir(), 'media-video-retry-')));
  const engine = new MediaEngine({
    store,
    getChannelFeedImpl: async () => [
      { videoId: 'broken-1', link: 'https://www.youtube.com/watch?v=broken-1', title: 'Vidéo indisponible' },
    ],
    getVideoInfoImpl: async () => { throw new Error('504 Gateway Timeout'); },
  });
  const result = await engine.runVideoCycle({ mediaSlug: 'investissement' });
  assert.equal(result[0].failed, true);
  assert.match(result[0].error, /504/);
  const event = store.getEvent('video-draft:investissement:broken-1');
  assert.equal(event.status, 'retryable-failure');
  assert.ok(Date.parse(event.nextRetryAt) > Date.now());
  assert.equal(shouldGenerateDraftForEvent(store, 'video-draft:investissement:broken-1'), false);
});

test('file éditoriale: même source ou titre voisin est bloqué sur un même média, sans bloquer un autre média', () => {
  const candidate = {
    title: 'Google actualise son SEO Starter Guide avec un cap débutant',
    primaryUrl: 'https://developers.google.com/search/docs/fundamentals/seo-starter-guide?utm_source=test',
  };
  const drafts = [{
    mediaSlug: 'affiliation', contentType: 'news', title: 'Google actualise son SEO Starter Guide avec un cap débutant',
    sourceUrls: ['https://developers.google.com/search/docs/fundamentals/seo-starter-guide'],
  }];
  assert.equal(findDraftConflict(candidate, drafts, { mediaSlug: 'affiliation', contentType: 'news' }).reason, 'same-source-url');
  assert.equal(findDraftConflict(candidate, drafts, { mediaSlug: 'logiciels', contentType: 'news' }), null);
  assert.equal(findInternalLinkConflict(candidate, [{ anchor: 'Google actualise son SEO Starter Guide avec un cap débutant', path: '/actualites/google-seo-starter-guide/' }]).path, '/actualites/google-seo-starter-guide/');
});

test('curation: les brouillons historiques restent récupérables mais les doublons sont quarantainés', () => {
  const report = curateDraftQueue([
    { path: '/drafts/old.json', draft: { mediaSlug: 'logiciels', contentType: 'news', title: 'Cloudflare annonce un modèle pour les agents IA', sourceUrls: ['https://blog.cloudflare.com/agent-access'], qa: { passed: true }, generatedAt: '2026-08-05T10:00:00Z' } },
    { path: '/drafts/new.json', draft: { mediaSlug: 'logiciels', contentType: 'news', title: 'Cloudflare annonce un modèle pour les agents IA', sourceUrls: ['https://blog.cloudflare.com/agent-access'], qa: { passed: true }, generatedAt: '2026-08-06T10:00:00Z' } },
  ]);
  assert.equal(report.quarantined, 1);
  assert.equal(report.retained, 1);
  assert.equal(report.decisions.find((entry) => entry.path === '/drafts/new.json').status, 'review-required');
  assert.equal(report.decisions.find((entry) => entry.path === '/drafts/old.json').status, 'quarantined');
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

test('preuves longues: toutes les grandes sections restent représentées dans la limite du prompt', () => {
  const html = Array.from({ length: 12 }, (_, index) => (
    `<h2>Étape ${index + 1}</h2><p>Instruction officielle ${index + 1} ${`détail-${index + 1} `.repeat(600)}</p>`
  )).join('');
  const evidence = extractBalancedEvidence(html, 12_000);
  assert.ok(evidence.length <= 12_000);
  for (let index = 1; index <= 12; index += 1) assert.match(evidence, new RegExp(`Étape ${index}(?:\\D|$)`));
  assert.match(evidence, /Instruction officielle 12/);
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

test('candidats: une actualité officielle récente et thématique franchit le seuil qualité', () => {
  const now = new Date('2026-08-05T12:00:00.000Z');
  const candidate = qualifyCandidate(clusterCandidates([{
    id: 'official-software', sourceId: 'official-software', sourceTier: 1, sourceOfficial: true,
    title: 'Un logiciel de productivité lance une nouvelle automatisation',
    url: 'https://official.example/actualites/automation',
    excerpt: 'Le logiciel détaille officiellement la nouvelle fonctionnalité.',
    publishedAt: '2026-08-05T08:00:00.000Z', media: ['logiciels'],
  }])[0], mediaBySlug('logiciels'), { now });

  assert.equal(candidate.status, 'qualified');
  assert.ok(candidate.score >= 70);
  assert.equal(candidate.officialSourceCount, 1);
});

test('candidats: une page officielle ancienne ne franchit pas le seuil à elle seule', () => {
  const now = new Date('2026-08-05T12:00:00.000Z');
  const candidate = qualifyCandidate(clusterCandidates([{
    id: 'old-official', sourceId: 'old-official', sourceTier: 1, sourceOfficial: true,
    title: 'Un logiciel publie une ancienne mise à jour',
    url: 'https://official.example/archive/ancienne-version',
    excerpt: 'Une version historique du logiciel et de son automatisation.',
    publishedAt: '2026-07-01T08:00:00.000Z', media: ['logiciels'],
  }])[0], mediaBySlug('logiciels'), { now });

  assert.equal(candidate.status, 'rejected');
  assert.ok(candidate.blockers.includes('score-inférieur-à-70'));
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

test('Hermes: les URL directes des posts x_search deviennent des preuves traçables', async () => {
  const client = new HermesClient({
    command: ['hermes'],
    env: {},
    executeImpl: async () => ({
      stdout: JSON.stringify({
        answer: 'Annonce officielle',
        citations: [],
        posts: [{ url: 'https://x.com/OpenAI/status/123', author: 'OpenAI', summary: 'Annonce produit', official: true }],
        degraded: true,
        degradedReason: 'citations structurées absentes',
      }),
      stderr: '',
      code: 0,
    }),
  });
  const result = await client.xSearch({ query: 'annonce OpenAI', mediaSlug: 'logiciels' });
  assert.equal(result.degraded, false);
  assert.equal(result.posts.length, 1);
  assert.deepEqual(result.citations, [{ url: 'https://x.com/OpenAI/status/123', title: 'Annonce produit' }]);
  assert.equal(result.degradedReason, null);
});

test('Hermes: exécute le CLI avec l’utilisateur du volume OAuth quand il est configuré', () => {
  assert.deepEqual(defaultHermesCommand({
    HERMES_DOCKER_USER: '10000:10000',
    HERMES_CONTAINER: 'hermes-agent',
    HERMES_BIN: '/opt/hermes/.venv/bin/hermes',
  }), [
    '/usr/bin/docker',
    'exec',
    '--user',
    '10000:10000',
    'hermes-agent',
    '/opt/hermes/.venv/bin/hermes',
  ]);
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

test('état éditorial: un échec QA est retenté une fois après révision du prompt', () => {
  const root = mkdtempSync(join(tmpdir(), 'media-retry-state-'));
  const store = new MediaStateStore(root);
  store.initialize();
  const key = 'video-draft:investissement:video-1';
  assert.equal(shouldGenerateDraftForEvent(store, key, 2), true);
  store.markEvent(key, { status: 'qa-failed', editorialRevision: 1 });
  assert.equal(shouldGenerateDraftForEvent(store, key, 2), true);
  store.markEvent(key, { status: 'qa-failed', editorialRevision: 2 });
  assert.equal(shouldGenerateDraftForEvent(store, key, 2), false);
  store.markEvent(key, { status: 'qa-passed', editorialRevision: 1 });
  assert.equal(shouldGenerateDraftForEvent(store, key, 2), false);
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
  assert.match(prompt, /BRIEF ÉDITORIAL SPÉCIFIQUE AU SITE/);
  assert.match(prompt, /Free, Pro et Business/);

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

test('rédaction vidéo: la source YouTube et l’offre exacte sont injectées sans dépendre du modèle', () => {
  const media = mediaBySlug('investissement');
  const candidate = {
    id: 'youtube-dzQLM3agA_o', mediaSlug: 'investissement', primaryUrl: 'https://www.youtube.com/watch?v=dzQLM3agA_o',
    title: 'Avis Deblock', status: 'qualified', corroborated: true, rumor: false,
    sources: [{ sourceId: 'youtube-investissement', url: 'https://www.youtube.com/watch?v=dzQLM3agA_o' }],
    offer: { id: 'deblock', name: 'Deblock', url: 'https://cyberindependant.com/deblock' },
  };
  const draft = normalizeDraft({
    title: 'Avis Deblock', slug: 'avis-deblock', description: 'Un avis complet sur Deblock.', body: '## Mon avis\n\nTexte utile.',
    sourceUrls: [], claims: [{ statement: 'Avis issu de la vidéo', sourceRefs: ['S1'] }],
  }, { contentType: 'video', candidate, media });

  assert.match(draft.body, /\[Voir la vidéo originale\]\(https:\/\/www\.youtube\.com\/watch\?v=dzQLM3agA_o\)/);
  assert.match(draft.body, /\[Découvrir Deblock via mon lien affilié\]\(https:\/\/cyberindependant\.com\/deblock\)/);
  assert.deepEqual(draft.sourceUrls, ['https://www.youtube.com/watch?v=dzQLM3agA_o']);
  assert.equal(draft.offer.id, 'deblock');
  assert.equal(normalizeDraft({ ...draft, slug: 'deblock-dzqlm3aga_o' }, { contentType: 'video', candidate, media }).slug, 'deblock-dzqlm3aga-o');
});

test('rédaction guide: le paquet conserve les preuves détaillées sans imposer un comparatif inventé', () => {
  const excerpt = 'preuve officielle détaillée '.repeat(400);
  const prompt = buildEditorialPrompt({
    media: mediaBySlug('logiciels'),
    contentType: 'guide',
    candidate: {
      id: 'guide-hostinger', title: 'Créer un site avec Hostinger', score: 90, keywordMatches: ['hébergement web'],
      sources: [{ sourceId: 'hostinger-tutorial', official: true, tier: 1, title: 'Tutoriel', url: 'https://www.hostinger.com/fr/tutoriels/site', excerpt }],
    },
  });
  assert.match(prompt, /Ne compare des alternatives que si/);
  assert.ok(prompt.includes(excerpt.slice(0, 8_000)));
});

test('rédaction: le prompt reprend les mentions exigées par la QA réglementaire', () => {
  const candidate = {
    id: 'candidate-finance-1',
    title: 'Comprendre un investissement',
    score: 90,
    keywordMatches: ['investissement'],
    sources: [],
  };
  const financePrompt = buildEditorialPrompt({
    media: mediaBySlug('investissement'),
    candidate,
    contentType: 'guide',
  });
  assert.match(financePrompt, /Ce contenu ne constitue pas un conseil en investissement\./);
  assert.match(financePrompt, /Tout investissement comporte un risque de perte en capital, partielle ou totale\./);

  const legalPrompt = buildEditorialPrompt({
    media: mediaBySlug('entreprise'),
    candidate,
    contentType: 'guide',
  });
  assert.match(legalPrompt, /Ce contenu ne constitue pas un conseil juridique ou fiscal personnalisé\./);
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

  const automaticQueue = await allowed.run({ dryRun: true });
  assert.equal(automaticQueue.results.length, 0);
  store.saveDraft('logiciels', {
    ...draft,
    candidateId: 'publication-eligible',
    publicationEligibility: { status: 'eligible', checkedAt: new Date().toISOString(), reason: null },
  });
  const eligibleQueue = await allowed.run({ dryRun: true });
  assert.equal(eligibleQueue.results.length, 1);
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

test('supervision: un échec vidéo ou un OOM systemd interdit le statut healthy', () => {
  const root = mkdtempSync(join(tmpdir(), 'media-monitor-video-'));
  const store = new MediaStateStore(root);
  store.write('source-health', {
    version: 1,
    updatedAt: new Date().toISOString(),
    sources: { official: { sourceId: 'official', required: true, status: 'healthy' } },
  });
  store.write('last-runs', {
    version: 1,
    runs: {
      run: { at: new Date().toISOString(), status: 'success' },
      video: { at: new Date().toISOString(), status: 'degraded' },
    },
  });
  store.write('systemd-video', {
    version: 1,
    observedAt: new Date().toISOString(),
    unit: 'video',
    result: 'oom-kill',
  });
  const health = new MediaEngine({ store }).healthReport();
  assert.equal(health.status, 'degraded');
  assert.ok(health.blockers.includes('last-video-run-degraded'));
  assert.ok(health.blockers.includes('video-service-oom-kill'));
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
    runtimeHealth: { status: 'healthy', blockers: [] },
    env: { MEDIA_ENGINE_PUBLICATION_MODE: 'draft' },
  });
  assert.equal(ready.readyForShadow, true);
  assert.equal(ready.readyForFullResearch, true);
  assert.equal(ready.readyForPublishing, false);

  const unhealthyPublishing = await runPreflight({
    hermes: {
      authList: async () => ({ raw: 'xai-oauth\nopenai-codex', providers: ['xai-oauth', 'openai-codex'] }),
      toolList: async () => '✓ enabled  image_gen  Image Generation',
      configGet: async () => 'gpt-image-2',
    },
    topicStatePath,
    siteConfigs,
    runtimeHealth: { status: 'degraded', blockers: ['last-video-run-degraded'] },
    env: {
      MEDIA_ENGINE_PUBLICATION_MODE: 'automatic',
      MEDIA_ENGINE_AUTOMATIC_PUBLICATION_APPROVED: 'true',
      MEDIA_ENGINE_PUSH_ENABLED: 'true',
      MEDIA_ENGINE_SHADOW_STARTED_AT: '2026-07-01T00:00:00.000Z',
    },
  });
  assert.equal(unhealthyPublishing.readyForPublishing, false);
  assert.equal(unhealthyPublishing.publishingChecks.find((entry) => entry.id === 'runtime-health').passed, false);

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
