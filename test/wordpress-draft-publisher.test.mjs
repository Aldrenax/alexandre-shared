import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MediaStateStore, writeJsonAtomic } from '../media/state-store.mjs';
import {
  markdownBlocks,
  assetForWordPressDraft,
  enabledWordPressMediaSlugs,
  endpointOrigin,
  payloadForWordPressDraft,
  renderWordPressContent,
  withVerifiedSourceDate,
  wordpressSiteUrls,
  wordpressTarget,
  WordPressDraftClient,
  WordPressDraftPublisher,
} from '../media/wordpress-draft-publisher.mjs';

const body = `Introduction sourcée avec [la source](https://example.com/annonce).

## Ancien intertitre

Premier paragraphe détaillé et vérifié.

Deuxième paragraphe explicatif.

## Autre partie

Troisième paragraphe utile.

Quatrième paragraphe de conclusion.`;

function draft(overrides = {}) {
  return {
    candidateId: 'candidate-123',
    mediaSlug: 'chaimbault',
    contentType: 'news',
    title: 'Une annonce vérifiée',
    slug: 'une-annonce-verifiee',
    description: 'Résumé factuel de cette annonce vérifiée.',
    body,
    wordCount: 1_200,
    generatedAt: '2026-08-21T10:00:00.000Z',
    scheduledPublishAt: '2026-08-21T12:00:00.000Z',
    sourceUrls: ['https://example.com/annonce'],
    sourcePublishedAt: '2026-08-21T08:00:00.000Z',
    keyPoints: ['Point clé confirmé', 'Conséquence pratique'],
    faq: [{ question: 'Comment commencer ?', answer: 'Commence par vérifier les prérequis.' }],
    qa: { passed: true },
    publicationEligibility: { status: 'eligible' },
    ...overrides,
  };
}

test('le convertisseur Markdown neutralise le HTML brut et rétrograde les anciens H2', () => {
  const blocks = markdownBlocks('## Titre\n\n<script>alert(1)</script>');
  assert.equal(blocks[0].html, '<h3>Titre</h3>');
  assert.match(blocks[1].html, /&lt;script&gt;/);
  assert.doesNotMatch(blocks[1].html, /<script>/);
});

test('les trois contrats WordPress ont uniquement les H2 canoniques', () => {
  const cases = [
    [draft(), ['Ce qui est confirmé', 'Pourquoi c’est important', 'Ce que cela change', 'Sources et méthode']],
    [draft({
      contentType: 'video',
      video: { videoId: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk' },
    }), ['La vidéo en bref', 'Transcription détaillée', 'Le point clé', 'Pour aller plus loin']],
    [draft({ contentType: 'guide' }), [
      'À qui s’adresse ce guide', 'Comprendre les fondamentaux', 'La méthode étape par étape',
      'Comparer les options', 'Questions fréquentes', 'Conclusion et prochaine étape',
    ]],
  ];
  for (const [value, expected] of cases) {
    const html = renderWordPressContent(value);
    assert.deepEqual([...html.matchAll(/<h2>(.*?)<\/h2>/gu)].map((match) => match[1]), expected);
    assert.ok((html.match(/<p>/gu) || []).length >= (value.contentType === 'guide' ? 7 : value.contentType === 'news' ? 5 : 4));
  }
});

test('le payload principal est brouillon, idempotent et conserve le contrat SEO', () => {
  const payload = payloadForWordPressDraft(draft());
  assert.equal(payload.candidate_id, 'media-engine:chaimbault:news:candidate-123');
  assert.equal(payload.content_type, 'article');
  assert.equal(payload.status, 'draft');
  assert.equal(payload.public_path, '/blog/une-annonce-verifiee/');
  assert.equal(payload.canonical_url, 'https://alexandrechaimbault.com/blog/une-annonce-verifiee/');
  assert.equal(payload.source_published_at, '2026-08-21T08:00:00.000Z');
  assert.match(payload.content_hash, /^[a-f0-9]{64}$/u);
  assert.throws(() => payloadForWordPressDraft(draft({ sourcePublishedAt: null })), /date de publication/);
});

test('les cinq médias thématiques ciblent leur blog, type Actualité et domaine WordPress exacts', () => {
  const cases = [
    ['affiliation', 'affiliation', 'alexandre-affiliation.fr'],
    ['logiciels', 'logiciels', 'alexandre-logiciels.fr'],
    ['entreprise', 'entreprise', 'alexandre-entreprise.fr'],
    ['tesla-tech', 'tesla', 'alexandre-tesla.fr'],
    ['investissement', 'investissement', 'alexandre-investissement.fr'],
  ];
  for (const [mediaSlug, siteKey, domain] of cases) {
    const payload = payloadForWordPressDraft(draft({ mediaSlug }));
    assert.equal(wordpressTarget({ mediaSlug }).siteKey, siteKey);
    assert.equal(payload.content_type, 'actualite');
    assert.equal(payload.site_key, siteKey);
    assert.equal(payload.public_path, '/actualites/une-annonce-verifiee/');
    assert.equal(payload.canonical_url, `https://${domain}/actualites/une-annonce-verifiee/`);
  }
});

test('les endpoints WordPress conservent les chemins Multisite et acceptent des overrides finaux explicites', () => {
  assert.equal(endpointOrigin('https://example.test/affiliation'), 'https://example.test/affiliation/');
  const env = {
    WORDPRESS_DRAFT_BASE_URL: 'https://alexandrechaimbault.com/',
    WORDPRESS_DRAFT_SITE_URLS_JSON: JSON.stringify({ affiliation: 'https://alexandre-affiliation.fr/' }),
  };
  const urls = wordpressSiteUrls(env);
  assert.equal(urls.chaimbault, 'https://alexandrechaimbault.com/');
  assert.equal(urls.logiciels, 'https://alexandrechaimbault.com/logiciels/');
  assert.equal(urls.affiliation, 'https://alexandre-affiliation.fr/');
  assert.deepEqual(enabledWordPressMediaSlugs({}), ['chaimbault']);
  assert.deepEqual(enabledWordPressMediaSlugs({ WORDPRESS_DRAFT_MEDIA_SLUGS: 'chaimbault,affiliation,affiliation' }), ['chaimbault', 'affiliation']);
  assert.throws(() => enabledWordPressMediaSlugs({ WORDPRESS_DRAFT_MEDIA_SLUGS: 'inconnu' }), /non pris en charge/u);
});

test('la bannière locale devient un asset borné et vérifié par SHA-256', () => {
  const root = mkdtempSync(join(tmpdir(), 'wordpress-asset-'));
  const bannerPath = join(root, 'banner.webp');
  writeFileSync(bannerPath, Buffer.from('fixture-image-bytes'));
  const asset = assetForWordPressDraft(draft({ banner: { path: bannerPath, alt: 'Bannière de test' } }));
  assert.equal(asset.mime, 'image/webp');
  assert.equal(asset.byte_length, 19);
  assert.match(asset.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(Buffer.from(asset.bytes_base64, 'base64').toString(), 'fixture-image-bytes');
  assert.equal(asset.asset_id, 'media-engine:chaimbault:news:candidate-123:banner');
  assert.equal(assetForWordPressDraft(draft({ contentType: 'video' })), null);
});

test('une ancienne actualité récupère uniquement une date issue de sa source officielle qualifiée', () => {
  const root = mkdtempSync(join(tmpdir(), 'wordpress-source-date-'));
  const store = new MediaStateStore(root);
  store.initialize();
  store.enqueue('qualified', 'chaimbault-candidate-123', {
    publishedAt: '2026-08-20T09:30:00.000Z',
    sources: [{
      official: true,
      url: 'https://example.com/annonce',
      publishedAt: '2026-08-20T09:30:00.000Z',
    }],
  });
  const enriched = withVerifiedSourceDate(store, draft({ sourcePublishedAt: null }));
  assert.equal(enriched.sourcePublishedAt, '2026-08-20T09:30:00.000Z');
  const unverified = withVerifiedSourceDate(store, draft({
    candidateId: 'unknown',
    sourcePublishedAt: null,
  }));
  assert.equal(unverified.sourcePublishedAt, null);
});

test('le client et le publisher prouvent le mode draft-only sans exposer le mot de passe', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    const target = String(url);
    const isHealth = target.endsWith('/health');
    const isAsset = target.endsWith('/assets');
    return new Response(JSON.stringify(isHealth
      ? { status: 'ok', site_key: 'principal', blog_id: 1, publication_mode: 'draft-only', can_publish: false, can_delete: false }
      : isAsset
        ? { status: 'asset-ready', result: 'created', attachment_id: 321, publication_mode: 'draft-only' }
        : { result: 'created', post_id: 432, post_status: 'draft', publication_mode: 'draft-only' }), {
      status: isHealth ? 200 : 201,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new WordPressDraftClient({
    baseUrl: 'https://staging.example.test/',
    username: 'hermes',
    applicationPassword: 'secret-application-password',
    fetchImpl,
  });
  const root = mkdtempSync(join(tmpdir(), 'wordpress-shadow-'));
  const bannerPath = join(root, 'banner.webp');
  writeFileSync(bannerPath, Buffer.from('fixture-image-bytes'));
  const store = new MediaStateStore(root);
  store.initialize();
  const draftPath = store.saveDraft('chaimbault', draft({ banner: { path: bannerPath, alt: 'Bannière de test' } }));
  const publisher = new WordPressDraftPublisher({ store, client, now: () => new Date('2026-08-21T13:00:00.000Z') });
  const receipt = await publisher.mirrorDraftPath(draftPath);
  assert.equal(receipt.wordpress.post_id, 432);
  assert.equal(receipt.status, 'draft-mirrored');
  assert.equal(requests.length, 3);
  assert.match(requests[0].options.headers.authorization, /^Basic /u);
  assert.match(requests[1].url, /\/assets$/u);
  assert.match(requests[2].url, /\/drafts$/u);
  assert.equal(JSON.parse(requests[2].options.body).featured_media, 321);
  assert.doesNotMatch(JSON.stringify(receipt), /secret-application-password/u);
  assert.equal(JSON.parse(readFileSync(receipt.receiptPath, 'utf8')).wordpress.post_status, 'draft');
});

test('la publication automatique téléverse la bannière et l’attache à l’article', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    const target = String(url);
    const isHealth = target.endsWith('/health');
    const isAsset = target.endsWith('/assets');
    return new Response(JSON.stringify(isHealth
      ? { status: 'ok', site_key: 'principal', blog_id: 1, publication_mode: 'auto-publish', can_publish: true, can_delete: false }
      : isAsset
        ? { status: 'asset-ready', result: 'created', attachment_id: 654, publication_mode: 'auto-publish' }
        : { result: 'created', post_id: 987, post_status: 'publish', published: true, publication_mode: 'auto-publish' }), {
      status: isHealth ? 200 : 201,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new WordPressDraftClient({
    baseUrl: 'https://production.example.test/',
    username: 'hermes',
    applicationPassword: 'secret-application-password',
    fetchImpl,
  });
  const root = mkdtempSync(join(tmpdir(), 'wordpress-publish-'));
  const bannerPath = join(root, 'banner.webp');
  writeFileSync(bannerPath, Buffer.from('fixture-image-bytes'));
  const store = new MediaStateStore(root);
  store.initialize();
  const draftPath = store.saveDraft('chaimbault', draft({ banner: { path: bannerPath, alt: 'Bannière de test' } }));
  const publisher = new WordPressDraftPublisher({ store, client, now: () => new Date('2026-08-21T13:00:00.000Z') });
  const receipt = await publisher.publishAutomaticDraftPath(draftPath);
  assert.equal(receipt.wordpress.post_id, 987);
  assert.equal(receipt.asset.attachment_id, 654);
  assert.equal(receipt.status, 'published-wordpress');
  assert.equal(requests.length, 3);
  assert.match(requests[1].url, /\/assets$/u);
  assert.match(requests[2].url, /\/drafts$/u);
  assert.equal(JSON.parse(requests[2].options.body).featured_media, 654);
  assert.doesNotMatch(JSON.stringify(receipt), /secret-application-password/u);
});

test('la reprise automatique conserve la bannière lors de la mise à jour d’un brouillon existant', async () => {
  const requests = [];
  const root = mkdtempSync(join(tmpdir(), 'wordpress-publish-resume-'));
  const bannerPath = join(root, 'banner.webp');
  writeFileSync(bannerPath, Buffer.from('fixture-image-bytes'));
  const store = new MediaStateStore(root);
  store.initialize();
  const value = draft({ banner: { path: bannerPath, alt: 'Bannière de reprise' } });
  const draftPath = store.saveDraft('chaimbault', value);
  const receiptPath = join(store.stateDir, 'wordpress-publication-receipts', 'chaimbault', `${value.slug}.json`);
  writeJsonAtomic(receiptPath, {
    wordpress: { candidate_id: 'media-engine:chaimbault:news:candidate-123', post_id: 432 },
  });
  const client = {
    health: async () => ({ body: { status: 'ok', site_key: 'principal', blog_id: 1, publication_mode: 'auto-publish', can_publish: true, can_delete: false } }),
    uploadAsset: async () => ({ body: { status: 'asset-ready', attachment_id: 654, publication_mode: 'auto-publish' } }),
    createDraft: async () => { throw new Error('WordPress HTTP 409: alexandre_network_candidate_payload_conflict'); },
    updateDraft: async (postId, payload) => {
      requests.push({ postId, payload });
      return { body: { post_id: postId, post_status: 'publish', published: true, publication_mode: 'auto-publish' } };
    },
  };
  const publisher = new WordPressDraftPublisher({ store, client });
  await publisher.publishAutomaticDraftPath(draftPath);
  assert.equal(requests[0].postId, 432);
  assert.equal(requests[0].payload.featured_media, 654);
  assert.equal(requests[0].payload.candidate_id, undefined);
  assert.equal(requests[0].payload.content_type, undefined);
});

test('le client conserve le sous-chemin du blog Multisite pour chaque endpoint', async () => {
  const requests = [];
  const client = new WordPressDraftClient({
    baseUrl: 'https://example.test/affiliation/',
    username: 'hermes',
    applicationPassword: 'application-password',
    fetchImpl: async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({
        status: 'ok',
        site_key: 'affiliation',
        blog_id: 5,
        publication_mode: 'draft-only',
        can_publish: false,
        can_delete: false,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  await client.health();
  assert.deepEqual(requests, ['https://example.test/affiliation/wp-json/alexandre-network/v1/health']);
});

test('la santé WordPress refuse tout droit natif de publication ou suppression', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wordpress-health-capabilities-'));
  const store = new MediaStateStore(root);
  store.initialize();
  const client = {
    health: async () => ({
      body: {
        status: 'ok',
        site_key: 'affiliation',
        blog_id: 5,
        publication_mode: 'draft-only',
        can_publish: true,
        can_delete: false,
      },
    }),
  };
  const publisher = new WordPressDraftPublisher({ store, client });
  await assert.rejects(() => publisher.healthForMedia('affiliation'), /affiliation.*brouillon sûr/u);
});

test('un média thématique est refusé si le endpoint répond avec l’identité d’un autre blog', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wordpress-shadow-wrong-site-'));
  const store = new MediaStateStore(root);
  store.initialize();
  const draftPath = store.saveDraft('affiliation', draft({
    mediaSlug: 'affiliation',
    contentType: 'video',
    video: { videoId: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk' },
  }));
  const client = {
    health: async () => ({ body: { status: 'ok', site_key: 'principal', publication_mode: 'draft-only' } }),
  };
  const publisher = new WordPressDraftPublisher({ store, client });
  await assert.rejects(() => publisher.mirrorDraftPath(draftPath), /affiliation.*brouillon sûr/u);
});

test('le run scanne uniquement les médias WordPress explicitement autorisés', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wordpress-shadow-network-'));
  const store = new MediaStateStore(root);
  store.initialize();
  const video = { videoId: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk' };
  store.saveDraft('chaimbault', draft({ candidateId: 'principal-one', contentType: 'video', video }));
  store.saveDraft('affiliation', draft({ mediaSlug: 'affiliation', candidateId: 'affiliate-one', contentType: 'video', video }));
  store.saveDraft('logiciels', draft({ mediaSlug: 'logiciels', candidateId: 'logiciels-one', contentType: 'video', video }));
  const publisher = new WordPressDraftPublisher({
    store,
    env: {
      WORDPRESS_DRAFT_MEDIA_SLUGS: 'chaimbault,affiliation',
      WORDPRESS_DRAFT_BASE_URL: 'https://example.test/',
    },
  });
  const result = await publisher.run({ dryRun: true, limit: 10 });
  assert.equal(result.inspected, 2);
  assert.deepEqual(result.results.map((row) => row.payload.site_key).sort(), ['affiliation', 'principal']);
});

test('un ancien brouillon incompatible est isolé sans bloquer le suivant', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wordpress-shadow-queue-'));
  const bannerPath = join(root, 'old-news.webp');
  writeFileSync(bannerPath, Buffer.from('fixture-image-bytes'));
  const store = new MediaStateStore(root);
  store.initialize();
  store.saveDraft('chaimbault', draft({
    candidateId: 'old-news',
    sourcePublishedAt: null,
    banner: { path: bannerPath, alt: 'Ancienne bannière' },
  }));
  store.saveDraft('chaimbault', draft({
    candidateId: 'valid-video',
    contentType: 'video',
    slug: 'valid-video',
    video: { videoId: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk' },
  }));
  const publisher = new WordPressDraftPublisher({ store });
  const result = await publisher.run({ dryRun: true, limit: 1 });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].payload.content_type, 'video');
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].candidateId, 'old-news');
  assert.match(result.skipped[0].reason, /date de publication/u);
});
