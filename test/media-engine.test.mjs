import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
import { loadEnvironmentFile } from '../media/environment.mjs';
import {
  ARTICLE_THUMBNAIL_POLICY,
  articleThumbnailProfile,
  buildBannerPrompt,
  buildEditorialPrompt,
  buildEditorialRepairPrompt,
  EDITORIAL_REVISION,
  normalizeDraft,
} from '../media/editorial.mjs';
import { publicationDecision, qaDraft } from '../media/qa.mjs';
import { MediaStateStore } from '../media/state-store.mjs';
import { auditDraftOutboundLinks, formatVideoDuration, renderMdxDraft } from '../media/site-publisher.mjs';
import { resolveTopicId, splitMessage } from '../media/telegram.mjs';
import { guideCandidate, selectGuideOpportunity } from '../media/guide-planner.mjs';
import { publicUrlForDraft, PublicationWorker, siteConfigsFromPayload } from '../media/publication-worker.mjs';
import {
  downloadFirstAvailableAsset,
  EVIDENCE_REVISION,
  materializeBanner,
  MediaEngine,
  offerForUrl,
  publishedVideoPath,
  qaCanBeRepaired,
  shouldGenerateDraftForEvent,
  transcriptBlockNeedsCaption,
  videoDraftReceipt,
} from '../media/engine.mjs';
import { runPreflight } from '../media/preflight.mjs';
import { recommendedPublicationTime } from '../media/publication-schedule.mjs';
import {
  readCachedTranscript, runYtDlpWithRetries, stickyProxyUrl, writeCachedTranscript, ytDlpNetworkEnv,
} from '../lib/whisper.mjs';
import { extractPublishedAt, getChannelFeed, getChannelFeedWithYtDlp, resolveVideoMetadata, youtubeThumbnailCandidates } from '../lib/youtube.mjs';

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

test('miniature article: adaptation image unique de youtube-thumbnail-imagegen et DA par chaîne', () => {
  const media = mediaBySlug('investissement');
  const draft = {
    contentType: 'guide',
    title: 'Le piège des frais invisibles',
    description: 'Un guide factuel sur les limites et les frais.',
    bannerBrief: {
      headline: 'FRAIS INVISIBLES',
      concept: 'Une facture simple avec une ligne de frais mise en évidence',
    },
  };
  const prompt = buildBannerPrompt({ media, draft });

  assert.equal(ARTICLE_THUMBNAIL_POLICY, 'youtube-thumbnail-imagegen:article-single-v1');
  assert.match(prompt, /UNE SEULE miniature/);
  assert.match(prompt, /Ne propose pas de variantes/);
  assert.match(prompt, /skill youtube-thumbnail-imagegen/);
  assert.match(prompt, /2 à 4 mots/);
  assert.match(prompt, /un seul élément dominant/);
  assert.match(prompt, /Aucun visage/);
  assert.match(prompt, /vert finance #024F02 a #007000/);
  assert.match(prompt, /Direction: Trap \/ Truth/);
  assert.match(prompt, /chiffres, prix, rendements, statistiques ou promesses non fournis et sourcés/);
  assert.match(articleThumbnailProfile(media).tone, /mesure/);
});

test('environnement: le fichier shadow remplace une variable principale vide', () => {
  const root = mkdtempSync(join(tmpdir(), 'media-env-layer-'));
  const main = join(root, 'main.env');
  const shadow = join(root, 'shadow.env');
  writeFileSync(main, 'MEDIA_ENGINE_SHADOW_STARTED_AT=\nMEDIA_ENGINE_PUBLICATION_MODE=draft\n');
  writeFileSync(shadow, 'MEDIA_ENGINE_SHADOW_STARTED_AT=2026-08-05T14:15:56Z\nMEDIA_ENGINE_PUBLICATION_MODE=automatic\n');
  const env = {};
  loadEnvironmentFile(main, env);
  loadEnvironmentFile(shadow, env);
  assert.equal(env.MEDIA_ENGINE_SHADOW_STARTED_AT, '2026-08-05T14:15:56Z');
  assert.equal(env.MEDIA_ENGINE_PUBLICATION_MODE, 'draft');
});

test('environnement: le fichier publication remplace explicitement les garde-fous shadow', () => {
  const root = mkdtempSync(join(tmpdir(), 'media-env-publication-'));
  const publication = join(root, 'publication.env');
  writeFileSync(publication, 'MEDIA_ENGINE_PUBLICATION_MODE=automatic\nMEDIA_ENGINE_PUSH_ENABLED=true\n');
  const env = { MEDIA_ENGINE_PUBLICATION_MODE: 'draft', MEDIA_ENGINE_PUSH_ENABLED: 'false' };
  loadEnvironmentFile(publication, env, { override: true });
  assert.equal(env.MEDIA_ENGINE_PUBLICATION_MODE, 'automatic');
  assert.equal(env.MEDIA_ENGINE_PUSH_ENABLED, 'true');
});

test('métadonnées YouTube: une date 1970 est rejetée au profit d’une date relative plausible', () => {
  const published = extractPublishedAt(
    { primary_info: { published: { text: 'il y a 2 jours' } } },
    { publish_date: '1970-01-01T00:00:00.000Z' },
  );
  assert.ok(published instanceof Date);
  assert.ok(published.getTime() > Date.parse('2020-01-01T00:00:00.000Z'));
});

test('santé: une source officielle complémentaire indisponible ne bloque pas le réseau', () => {
  const banqueDeFrance = MEDIA_SOURCES.find((source) => source.id === 'banque-france-news');
  assert.equal(banqueDeFrance.required, false);
  const root = mkdtempSync(join(tmpdir(), 'media-optional-source-'));
  const store = new MediaStateStore(root);
  store.write('source-health', {
    version: 1,
    updatedAt: new Date().toISOString(),
    sources: {
      amf: { sourceId: 'amf', required: true, status: 'healthy' },
      bce: { sourceId: 'bce', required: true, status: 'healthy' },
      banqueDeFrance: { sourceId: 'banque-france-news', required: false, status: 'quarantined' },
    },
  });
  store.write('last-runs', {
    version: 1,
    runs: { run: { at: new Date().toISOString(), status: 'success' } },
  });
  const health = new MediaEngine({ store }).healthReport();
  assert.equal(health.status, 'healthy');
  assert.ok(!health.blockers.includes('required-sources-degraded'));
});

test('santé: Search Engine Watch reste un complément non bloquant aux sources SEO', () => {
  const searchEngineWatch = MEDIA_SOURCES.find((source) => source.id === 'search-engine-watch');
  assert.equal(searchEngineWatch.required, false);
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
    env: { HTTP_PROXY_URL: 'http://user:password@geo.iproyal.com:12321', YTDLP_ALLOW_DIRECT_FALLBACK: 'false' },
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

test('transcription YouTube: le cache de sous-titres Studio est partagé avec Hermes sans secret OAuth', () => {
  const root = mkdtempSync(join(tmpdir(), 'caption-cache-'));
  const env = { MEDIA_ENGINE_RUNTIME_DIR: root };
  const transcript = 'sous-titre officiel '.repeat(50);
  assert.ok(writeCachedTranscript('caption-123', transcript, env));
  assert.equal(readCachedTranscript('caption-123', env), transcript.trim());
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
  assert.equal(result[0].retryScheduled, true);
  assert.match(result[0].error, /504/);
  const event = store.getEvent('video-draft:investissement:broken-1');
  assert.equal(event.status, 'retryable-failure');
  assert.ok(Date.parse(event.nextRetryAt) > Date.now());
  assert.equal(shouldGenerateDraftForEvent(store, 'video-draft:investissement:broken-1'), false);
});

test('cycle vidéo: une vidéo historique RSS est classée sans transcription coûteuse', async () => {
  const store = new MediaStateStore(mkdtempSync(join(tmpdir(), 'media-video-historical-')));
  let infoCalls = 0;
  const engine = new MediaEngine({
    store,
    env: { MEDIA_ENGINE_VIDEO_LOOKBACK_DAYS: '7' },
    getChannelFeedImpl: async () => [{
      videoId: 'historical-1',
      link: 'https://www.youtube.com/watch?v=historical-1',
      title: 'Ancienne vidéo',
      pubDate: new Date(Date.now() - 30 * 86_400_000),
    }],
    getVideoInfoImpl: async () => { infoCalls += 1; return {}; },
  });
  const result = await engine.runVideoCycle({ mediaSlug: 'chaimbault' });
  assert.equal(result[0].reason, 'historical-video-outside-lookback');
  assert.equal(infoCalls, 0);
  assert.equal(store.getEvent('video-draft:chaimbault:historical-1').status, 'historical-video-skipped');
});

test('cycle vidéo: une reprise persistée survit à la disparition de la vidéo du RSS', async () => {
  const store = new MediaStateStore(mkdtempSync(join(tmpdir(), 'media-video-persisted-retry-')));
  store.markEvent('video-draft:chaimbault:olderVideo123', {
    status: 'retryable-failure',
    reason: 'ancienne panne transitoire',
    nextRetryAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const engine = new MediaEngine({
    store,
    getChannelFeedImpl: async () => [],
  });
  const result = await engine.runVideoCycle({ mediaSlug: 'chaimbault', dryRun: true });
  assert.equal(result[0].planned, true);
  assert.equal(result[0].video.videoId, 'olderVideo123');
  assert.equal(result[0].video.retrySource, 'persisted-backlog');
});

test('cycle vidéo: une transcription absente demande les sous-titres au Studio sans toucher OAuth', async () => {
  const store = new MediaStateStore(mkdtempSync(join(tmpdir(), 'media-caption-request-')));
  const engine = new MediaEngine({
    store,
    getChannelFeedImpl: async () => [
      { videoId: 'caption-123', link: 'https://www.youtube.com/watch?v=caption-123', title: 'Vidéo à sous-titrer' },
    ],
    getVideoInfoImpl: async () => ({ transcriptText: '', title: 'Vidéo à sous-titrer', isShort: false, isLive: false }),
  });
  const result = await engine.runVideoCycle({ mediaSlug: 'investissement' });
  assert.equal(result[0].reason, 'transcript-unavailable-caption-requested');
  const requests = store.read('events');
  assert.equal(requests.events['video-draft:investissement:caption-123'].reason, 'transcript-unavailable-caption-requested');
  const requestPath = join(store.queueDir, 'caption-requests', 'caption-123.json');
  assert.equal(JSON.parse(readFileSync(requestPath, 'utf8')).channelId, mediaBySlug('investissement').channelId);
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
  assert.equal(findDraftConflict(candidate, [{ ...drafts[0], qa: { passed: false } }], { mediaSlug: 'affiliation', contentType: 'news' }), null);
  assert.equal(findInternalLinkConflict(candidate, [{ anchor: 'Google actualise son SEO Starter Guide avec un cap débutant', path: '/actualites/google-seo-starter-guide/' }]).path, '/actualites/google-seo-starter-guide/');
});

test('file éditoriale API: un endpoint partagé ne confond pas deux campagnes officielles', () => {
  const endpoint = 'https://api.nhtsa.gov/recalls/recallsByVehicle?make=Tesla';
  const candidate = (itemId) => ({
    id: `candidate-${itemId}`,
    title: 'BACK OVER PREVENTION: SENSING SYSTEM: CAMERA',
    primaryUrl: endpoint,
    sources: [{
      sourceId: 'nhtsa-recalls',
      kind: 'official-api',
      itemId,
      url: endpoint,
    }],
  });
  const drafts = [{
    mediaSlug: 'tesla-tech',
    contentType: 'news',
    title: 'BACK OVER PREVENTION: SENSING SYSTEM: CAMERA',
    sourceUrls: [endpoint],
    sourceItemIds: ['nhtsa-recalls:24V935000'],
  }];

  assert.equal(findDraftConflict(candidate('24V935000'), drafts, { mediaSlug: 'tesla-tech', contentType: 'news' }).reason, 'same-source-item');
  assert.equal(findDraftConflict(candidate('26V315000'), drafts, { mediaSlug: 'tesla-tech', contentType: 'news' }), null);
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

test('curation de bascule: vidéos pré-cutover et actualités périmées exigent une revue', () => {
  const now = new Date('2026-08-12T14:20:00.000Z');
  const report = curateDraftQueue([
    { path: '/drafts/video.json', draft: { mediaSlug: 'chaimbault', contentType: 'video', title: 'Vidéo historique', sourceUrls: ['https://youtube.com/watch?v=1'], qa: { passed: true }, generatedAt: '2026-08-12T12:00:00.000Z', publicationEligibility: { status: 'eligible' } } },
    { path: '/drafts/news.json', draft: { mediaSlug: 'logiciels', contentType: 'news', title: 'Actualité ancienne', sourceUrls: ['https://example.com/news'], qa: { passed: true }, generatedAt: '2026-08-08T12:00:00.000Z', publicationEligibility: { status: 'eligible' } } },
    { path: '/drafts/guide.json', draft: { mediaSlug: 'entreprise', contentType: 'guide', title: 'Guide durable', sourceUrls: ['https://example.com/guide'], qa: { passed: true }, generatedAt: '2026-08-06T12:00:00.000Z', publicationEligibility: { status: 'eligible' } } },
  ], {}, { now, automaticCutoverAt: '2026-08-12T14:15:56.000Z', newsMaxAgeHours: 72 });
  assert.equal(report.decisions.find((entry) => entry.path.endsWith('video.json')).status, 'review-required');
  assert.equal(report.decisions.find((entry) => entry.path.endsWith('news.json')).status, 'review-required');
  assert.equal(report.decisions.find((entry) => entry.path.endsWith('guide.json')).status, 'eligible');
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

test('candidats API: deux campagnes officielles partageant un endpoint gardent deux identités', () => {
  const shared = {
    sourceId: 'nhtsa-recalls',
    sourceTier: 0,
    sourceOfficial: true,
    title: 'BACK OVER PREVENTION: SENSING SYSTEM: CAMERA',
    url: 'https://api.nhtsa.gov/recalls/recallsByVehicle?make=Tesla',
    excerpt: 'Campagne officielle.',
    publishedAt: '2026-08-14T08:00:00.000Z',
    media: ['tesla-tech'],
    kind: 'official-api',
  };
  const clusters = clusterCandidates([
    { ...shared, id: '24V935000' },
    { ...shared, id: '26V315000' },
  ]);

  assert.equal(clusters.length, 2);
  assert.notEqual(clusters[0].id, clusters[1].id);
  assert.deepEqual(new Set(clusters.flatMap((cluster) => cluster.sources.map((source) => source.itemId))), new Set(['24V935000', '26V315000']));
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

test('Hermes: les prompts Docker longs passent par stdin et jamais dans argv', async () => {
  const calls = [];
  const client = new HermesClient({
    command: ['/usr/bin/docker', 'exec', '--user', '10000:10000', 'hermes-agent', '/opt/hermes/.venv/bin/hermes'],
    env: {},
    executeImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: '{"ok":true}', stderr: '', code: 0 };
    },
  });
  const prompt = 'preuve '.repeat(40_000);
  assert.deepEqual(await client.oneshotJson(prompt, { model: 'gpt-5.6-terra', provider: 'openai-codex' }), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/usr/bin/docker');
  assert.ok(calls[0].args.includes('-i'));
  assert.ok(calls[0].args.includes('-c'));
  assert.ok(!calls[0].args.includes(prompt));
  assert.match(calls[0].options.input, /preuve preuve/);
});

test('cycle vidéo: un doublon publié est classé comme historique, avec son motif', () => {
  assert.deepEqual(videoDraftReceipt({
    status: 'blocked',
    reason: 'already-published-or-similar',
    publishedPath: '/blog/article-existant/',
  }, 'youtube-123'), {
    status: 'already-published',
    reason: 'already-published-or-similar',
    path: '/blog/article-existant/',
    editorialRevision: EDITORIAL_REVISION,
    candidateId: 'youtube-123',
  });
});

test('cycle vidéo: un ancien blocage sans motif est repris une seule fois', () => {
  const store = new MediaStateStore(mkdtempSync(join(tmpdir(), 'media-video-legacy-blocked-')));
  store.markEvent('video-draft:chaimbault:legacy', { status: 'editorial-blocked' });
  assert.equal(shouldGenerateDraftForEvent(store, 'video-draft:chaimbault:legacy'), true);
  store.markEvent('video-draft:chaimbault:legacy', { status: 'editorial-blocked', reason: 'source-insuffisante' });
  assert.equal(shouldGenerateDraftForEvent(store, 'video-draft:chaimbault:legacy'), false);
  store.markEvent('video-draft:chaimbault:legacy', {
    status: 'editorial-blocked',
    reason: 'source-insuffisante',
    editorialRevision: EDITORIAL_REVISION - 1,
  });
  assert.equal(shouldGenerateDraftForEvent(store, 'video-draft:chaimbault:legacy'), true);
  store.markEvent('video-draft:chaimbault:legacy', {
    status: 'editorial-blocked',
    reason: 'source-insuffisante',
    editorialRevision: EDITORIAL_REVISION,
  });
  assert.equal(shouldGenerateDraftForEvent(store, 'video-draft:chaimbault:legacy'), false);
});

test('cycle actualité: une nouvelle révision de preuve reprend un report une seule fois', () => {
  const store = new MediaStateStore(mkdtempSync(join(tmpdir(), 'media-evidence-revision-')));
  const key = 'draft:entreprise:c3iv:news';
  store.markEvent(key, {
    status: 'retryable-failure',
    reason: 'source-officielle-inaccessible',
    nextRetryAt: '2099-01-01T00:00:00.000Z',
    evidenceRevision: EVIDENCE_REVISION - 1,
  });
  assert.equal(shouldGenerateDraftForEvent(store, key), true);

  store.markEvent(key, {
    status: 'retryable-failure',
    reason: 'source-officielle-inaccessible',
    nextRetryAt: '2099-01-01T00:00:00.000Z',
    evidenceRevision: EVIDENCE_REVISION,
  });
  assert.equal(shouldGenerateDraftForEvent(store, key), false);
});

test('cycle vidéo: une transcription tronquée bascule vers les sous-titres officiels', () => {
  const store = new MediaStateStore(mkdtempSync(join(tmpdir(), 'media-video-truncated-caption-')));
  const key = 'video-draft:chaimbault:truncated';
  store.markEvent(key, {
    status: 'editorial-blocked',
    reason: 'La transcription fournie est tronquée avant la fin.',
  });
  assert.equal(transcriptBlockNeedsCaption(store.getEvent(key).reason), true);
  assert.equal(shouldGenerateDraftForEvent(store, key), true);
  assert.equal(transcriptBlockNeedsCaption('source officielle insuffisante'), false);
});

test('cycle vidéo: la réception des sous-titres officiels débloque immédiatement la reprise', () => {
  const store = new MediaStateStore(mkdtempSync(join(tmpdir(), 'media-video-caption-complete-')));
  store.enqueue('caption-requests', 'captionDone123', {
    version: 1,
    videoId: 'captionDone123',
    status: 'complete',
  });
  const key = 'video-draft:chaimbault:captionDone123';
  store.markEvent(key, {
    status: 'retryable-failure',
    reason: 'transcript-incomplete-caption-requested',
    nextRetryAt: new Date(Date.now() + 6 * 3_600_000).toISOString(),
  });
  assert.equal(shouldGenerateDraftForEvent(store, key), true);

  store.enqueue('caption-requests', 'captionUnavailable123', {
    version: 1,
    videoId: 'captionUnavailable123',
    status: 'complete',
  });
  const unavailableKey = 'video-draft:chaimbault:captionUnavailable123';
  store.markEvent(unavailableKey, {
    status: 'retryable-failure',
    reason: 'transcript-unavailable-caption-requested',
    nextRetryAt: new Date(Date.now() + 6 * 3_600_000).toISOString(),
  });
  assert.equal(shouldGenerateDraftForEvent(store, unavailableKey), true);
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
    '-i',
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

test('rédaction: une petite erreur QA déclenche une seule réparation bornée', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-qa-repair-'));
  const thumbnailPath = join(root, 'thumbnail.jpg');
  writeFileSync(thumbnailPath, Buffer.alloc(12_000, 1));
  const sourceUrl = 'https://www.youtube.com/watch?v=repairVideo1';
  const title = 'Croire en l’exponentielle pour développer son activité';
  const candidate = {
    id: 'youtube-repairVideo1',
    mediaSlug: 'chaimbault',
    title,
    primaryUrl: sourceUrl,
    score: 100,
    status: 'qualified',
    corroborated: true,
    rumor: false,
    sources: [{ sourceId: 'youtube-chaimbault', tier: 0, official: true, title, url: sourceUrl }],
    offer: null,
  };
  const payload = (wordCount) => ({
    title,
    slug: 'croire-en-lexponentielle-pour-developper-son-activite',
    description: 'Une analyse détaillée et fidèle de la vidéo pour comprendre la croissance exponentielle appliquée à une activité.',
    body: `## Analyse\n\n[Voir la vidéo](${sourceUrl})\n\n${'explication '.repeat(wordCount)}`,
    category: 'analyse',
    tags: ['business'],
    keyPoints: ['Comprendre la progression'],
    faq: [],
    sourceUrls: [sourceUrl],
    claims: [{ statement: 'La vidéo présente une progression exponentielle', sourceRefs: ['S1'] }],
    bannerBrief: { headline: '', concept: 'Courbe de progression', alt: 'Courbe de progression exponentielle' },
  });
  const prompts = [];
  const engine = new MediaEngine({
    store: new MediaStateStore(root),
    env: { MEDIA_ENGINE_QA_REPAIR_ATTEMPTS: '1' },
    hermes: {
      generateEditorialJson: async (prompt) => {
        prompts.push(prompt);
        return prompts.length === 1 ? payload(1_850) : payload(2_100);
      },
    },
  });
  const draft = await engine.generateDraft(candidate, {
    contentType: 'video',
    video: { videoId: 'repairVideo1', title, url: sourceUrl, thumbnailPath, thumbnailAlt: title },
    generateBanner: false,
  });

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /RÉPARATION QA BORNÉE/);
  assert.equal(draft.qa.passed, true);
  assert.deepEqual(draft.qaRepair.initialIssueCodes, ['word-count-low']);
  assert.equal(draft.qaRepair.attempts, 1);
  assert.equal(draft.qaRepair.resolved, true);
  assert.equal(qaCanBeRepaired({ issues: [{ code: 'word-count-low', severity: 'error' }] }), true);
  assert.equal(qaCanBeRepaired({ issues: [{ code: 'rumor-blocked', severity: 'error' }] }), false);

  const repairPrompt = buildEditorialRepairPrompt({
    media: mediaBySlug('chaimbault'), candidate, contentType: 'video', draft, qa: draft.qa,
  });
  assert.match(repairPrompt, /N’ajoute aucun fait/);
  assert.match(repairPrompt, new RegExp(title));
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

  const prompt = buildEditorialPrompt({ media, candidate, contentType: 'video', video: { transcript: 'transcription complète' } });
  assert.match(prompt, /La vidéo est la source primaire de cette adaptation/);
  assert.match(prompt, /L’absence de source externe ne suffit pas/);
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
  assert.match(prompt, /vise au moins 3900 mots utiles/);
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
    '[Hub](https://alexandrechaimbault.com)',
    '[Formation](https://formations.alexandrechaimbault.com/f/youtube-expert)',
    '[Agence](https://askoptimize.com)',
  ].join('\n'), draft, media);
  assert.equal(accepted.passed, true);

  const rejected = auditDraftOutboundLinks([
    '[Source](https://openai.com/index/annonce)',
    '[Offre injectée](https://cyberindependant.com/curve?utm_source=alexandre-logiciels)',
  ].join('\n'), draft, media);
  assert.equal(rejected.passed, false);
  assert.deepEqual(rejected.unexpected, ['https://cyberindependant.com/curve?utm_source=alexandre-logiciels']);
});

test('publication: le site cloné installe ses dépendances avant le build', async () => {
  const calls = [];
  const publisher = new (await import('../media/site-publisher.mjs')).SitePublisher({
    repoPath: '/tmp/alexandre-site-build-test',
    media: mediaBySlug('logiciels'),
    executeImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  await publisher.prepareWorkspace();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['ci', '--ignore-scripts']);
  assert.equal(calls[0].options.cwd, '/tmp/alexandre-site-build-test');
});

test('publication VPS: npm utilise le cache runtime autorisé par systemd', () => {
  const unit = readFileSync(new URL('../deploy/systemd/alexandre-media-publish.service', import.meta.url), 'utf8');
  assert.match(unit, /^Environment=NPM_CONFIG_CACHE=\/var\/lib\/alexandre-media-engine\/npm-cache$/m);
  assert.match(unit, /^ReadWritePaths=.*\/var\/lib\/alexandre-media-engine(?:\s|$)/m);
});

test('publication VPS: le CLI conserve le résultat pour enregistrer le cycle', () => {
  const cli = readFileSync(new URL('../bin/media-engine.mjs', import.meta.url), 'utf8');
  assert.match(cli, /result = draftPath\s*\? await worker\.publishDraftPath/);
  assert.match(cli, /output\(result\);/);
  assert.match(cli, /classifyRunOutcome\(command, result/);
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

test('publication automatique: la bascule ignore l’historique et impose un rythme réseau', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-publication-cutover-'));
  const store = new MediaStateStore(root);
  store.initialize();
  const common = {
    publicationMode: 'draft',
    qa: { passed: true },
    publicationEligibility: { status: 'eligible' },
  };
  store.saveDraft('chaimbault', {
    ...common,
    candidateId: 'old-video',
    mediaSlug: 'chaimbault',
    contentType: 'video',
    slug: 'ancienne-video',
    title: 'Ancienne vidéo',
    generatedAt: '2026-08-10T08:00:00.000Z',
    scheduledPublishAt: '2026-08-10T09:00:00.000Z',
  });
  store.saveDraft('entreprise', {
    ...common,
    candidateId: 'evergreen-guide',
    mediaSlug: 'entreprise',
    contentType: 'guide',
    slug: 'guide-durable',
    title: 'Guide durable',
    generatedAt: '2026-08-10T10:00:00.000Z',
    scheduledPublishAt: '2026-08-10T11:00:00.000Z',
  });
  const now = new Date('2026-08-12T16:20:00.000Z');
  const worker = new PublicationWorker({
    store,
    siteConfigs: siteConfigsFromPayload({
      entreprise: { repository: 'git@github.com:Aldrenax/alexandre-entreprise.git', branch: 'main' },
    }),
    env: {
      MEDIA_ENGINE_PUBLICATION_MODE: 'automatic',
      MEDIA_ENGINE_AUTOMATIC_PUBLICATION_APPROVED: 'true',
      MEDIA_ENGINE_PUSH_ENABLED: 'true',
      MEDIA_ENGINE_SHADOW_STARTED_AT: '2026-08-01T00:00:00.000Z',
      MEDIA_ENGINE_AUTOMATIC_CUTOVER_AT: '2026-08-12T14:15:56.000Z',
      MEDIA_ENGINE_PUBLICATION_MIN_INTERVAL_MINUTES: '90',
    },
    now: () => now,
  });
  const first = await worker.run({ dryRun: true });
  assert.equal(first.results.length, 1);
  assert.match(first.results[0].publicUrl, /alexandre-entreprise\.fr\/guides\/guide-durable/);
  assert.ok(first.held.some((entry) => entry.blockers.includes('historical-video-before-automatic-cutover')));

  store.markEvent('published:logiciels:news:recent', {
    status: 'published',
    mediaSlug: 'logiciels',
    publishedAt: new Date(now.getTime() - 30 * 60_000).toISOString(),
  });
  const throttled = await worker.run({ dryRun: true });
  assert.equal(throttled.results.length, 0);
  assert.ok(throttled.held.some((entry) => entry.blockers.some((blocker) => blocker.startsWith('network-cooldown-until-'))));
});

test('publication automatique: un lease interdit deux workers simultanés', async () => {
  const store = new MediaStateStore(mkdtempSync(join(tmpdir(), 'media-publication-lease-')));
  store.initialize();
  const lease = store.acquireLease('publication-cycle');
  const worker = new PublicationWorker({ store });
  const result = await worker.run();
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'publication-lease-active');
  store.releaseLease(lease);
});

test('publication automatique: un push Cloudflare tardif est réconcilié et notifié comme publié', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-publication-reconcile-'));
  const store = new MediaStateStore(root);
  store.initialize();
  const draftPath = store.saveDraft('entreprise', {
    candidateId: 'qonto-guide',
    mediaSlug: 'entreprise',
    contentType: 'guide',
    slug: 'qonto-guide',
    title: 'Guide Qonto vérifié',
    banner: { path: '/tmp/qonto.webp' },
  });
  const receiptPath = join(store.stateDir, 'publication-receipts', 'entreprise', 'qonto-guide.json');
  mkdirSync(join(store.stateDir, 'publication-receipts', 'entreprise'), { recursive: true });
  writeFileSync(receiptPath, JSON.stringify({
    status: 'pushed-unverified',
    publishedAt: '2026-08-12T14:23:24.495Z',
    mediaSlug: 'entreprise',
    contentType: 'guide',
    slug: 'qonto-guide',
    draftPath,
    publicUrl: 'https://alexandre-entreprise.fr/guides/qonto-guide',
    commit: 'abc123',
  }));
  store.markEvent('published:entreprise:guide:qonto-guide', JSON.parse(readFileSync(receiptPath, 'utf8')));
  const worker = new PublicationWorker({
    store,
    fetchImpl: async () => new Response('<title>Guide Qonto vérifié</title>', { status: 200 }),
    now: () => new Date('2026-08-12T14:25:00.000Z'),
  });
  const reconciliation = await worker.reconcileUnverified();
  assert.equal(reconciliation.results[0].status, 'published');
  assert.equal(JSON.parse(readFileSync(receiptPath, 'utf8')).live.verified, true);
  const eventPath = join(store.queueDir, 'events', 'publication-verified-entreprise-guide-qonto-guide.json');
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  assert.equal(event.type, 'editorial.article.published');
  assert.equal(event.title, 'Guide Qonto vérifié');
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

test('supervision: le rapport expose le mode de publication réel', () => {
  const store = new MediaStateStore(mkdtempSync(join(tmpdir(), 'media-health-publication-mode-')));
  const engine = new MediaEngine({ store, env: { MEDIA_ENGINE_PUBLICATION_MODE: 'automatic' } });
  assert.equal(engine.healthReport().publicationMode, 'automatic');
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

test('supervision: un cycle vidéo vide ne masque pas une reprise encore prête', () => {
  const root = mkdtempSync(join(tmpdir(), 'media-monitor-video-backlog-'));
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
      video: { at: new Date().toISOString(), status: 'success' },
    },
  });
  store.markEvent('video-draft:chaimbault:retry-me', {
    status: 'retryable-failure',
    reason: 'transient',
    nextRetryAt: new Date(Date.now() - 60_000).toISOString(),
  });
  store.markEvent('video-draft:chaimbault:already-done', {
    status: 'already-published',
  });
  const health = new MediaEngine({ store }).healthReport();
  assert.equal(health.status, 'degraded');
  assert.ok(health.blockers.includes('video-retryable-failures-ready'));
  assert.deepEqual(health.videoBacklog, {
    retryableReady: 1,
    retryableDeferred: 0,
    qaFailed: 0,
    editorialBlocked: 0,
  });
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

  const warningPublishing = await runPreflight({
    hermes: {
      authList: async () => ({ raw: 'xai-oauth\nopenai-codex', providers: ['xai-oauth', 'openai-codex'] }),
      toolList: async () => '✓ enabled  image_gen  Image Generation',
      configGet: async () => 'gpt-image-2',
    },
    topicStatePath,
    siteConfigs,
    runtimeHealth: { status: 'degraded', blockers: [], warnings: ['video-retries-scheduled'] },
    env: {
      MEDIA_ENGINE_PUBLICATION_MODE: 'automatic',
      MEDIA_ENGINE_AUTOMATIC_PUBLICATION_APPROVED: 'true',
      MEDIA_ENGINE_PUSH_ENABLED: 'true',
      MEDIA_ENGINE_SHADOW_STARTED_AT: '2026-07-01T00:00:00.000Z',
    },
  });
  assert.equal(warningPublishing.readyForPublishing, true);

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
  assert.equal(results.length, 1);
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

test('recherche X: le budget hebdomadaire évite les appels redondants entre deux fenêtres', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-x-budget-'));
  const store = new MediaStateStore(root);
  store.write('x-search-latest', { version: 1, updatedAt: new Date().toISOString(), results: [] });
  let xSearchCalls = 0;
  const engine = new MediaEngine({
    store,
    hermes: {
      authList: async () => ({ raw: 'xai-oauth', providers: ['xai-oauth'] }),
      xSearch: async () => { xSearchCalls += 1; return { citations: [], posts: [], degraded: false }; },
    },
  });
  const results = await engine.researchX({ mediaSlug: 'logiciels' });
  assert.deepEqual(results, []);
  assert.equal(xSearchCalls, 0);
  assert.equal(store.read('x-search-policy').deferredReason, 'x-search-interval-not-elapsed');
});

test('recherche X: une fenêtre éligible est bornée depuis le dernier passage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-x-window-'));
  const store = new MediaStateStore(root);
  const previousAt = new Date(Date.now() - 8 * 24 * 3_600_000);
  store.write('x-search-latest', { version: 1, updatedAt: previousAt.toISOString(), results: [] });
  const calls = [];
  const engine = new MediaEngine({
    store,
    hermes: {
      authList: async () => ({ raw: 'xai-oauth', providers: ['xai-oauth'] }),
      xSearch: async (options) => {
        calls.push(options);
        return { query: options.query, citations: [], posts: [], degraded: false };
      },
    },
  });
  const results = await engine.researchX({ mediaSlug: 'logiciels' });
  assert.equal(results.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fromDate, previousAt.toISOString().slice(0, 10));
  assert.equal(calls[0].toDate, new Date().toISOString().slice(0, 10));
  assert.deepEqual(store.read('x-search-latest').searchWindow, {
    fromDate: calls[0].fromDate,
    toDate: calls[0].toDate,
  });
});
