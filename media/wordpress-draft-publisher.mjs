import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { readJson, writeJsonAtomic } from './state-store.mjs';

export const WORDPRESS_TARGETS = Object.freeze({
  chaimbault: Object.freeze({ siteKey: 'principal', domain: 'alexandrechaimbault.com', stagingPath: '/', newsType: 'article', newsRoute: 'blog' }),
  affiliation: Object.freeze({ siteKey: 'affiliation', domain: 'alexandre-affiliation.fr', stagingPath: '/affiliation/', newsType: 'actualite', newsRoute: 'actualites' }),
  logiciels: Object.freeze({ siteKey: 'logiciels', domain: 'alexandre-logiciels.fr', stagingPath: '/logiciels/', newsType: 'actualite', newsRoute: 'actualites' }),
  entreprise: Object.freeze({ siteKey: 'entreprise', domain: 'alexandre-entreprise.fr', stagingPath: '/entreprise/', newsType: 'actualite', newsRoute: 'actualites' }),
  'tesla-tech': Object.freeze({ siteKey: 'tesla', domain: 'alexandre-tesla.fr', stagingPath: '/tesla/', newsType: 'actualite', newsRoute: 'actualites' }),
  investissement: Object.freeze({ siteKey: 'investissement', domain: 'alexandre-investissement.fr', stagingPath: '/investissement/', newsType: 'actualite', newsRoute: 'actualites' }),
});
const EDITORIAL_HEADINGS = Object.freeze({
  news: ['Ce qui est confirmé', 'Pourquoi c’est important', 'Ce que cela change', 'Sources et méthode'],
  video: ['La vidéo en bref', 'Transcription détaillée', 'Le point clé', 'Pour aller plus loin'],
  guide: [
    'À qui s’adresse ce guide',
    'Comprendre les fondamentaux',
    'La méthode étape par étape',
    'Comparer les options',
    'Questions fréquentes',
    'Conclusion et prochaine étape',
  ],
});
const WORDPRESS_ASSET_MAX_BYTES = 3_145_728;
const IMAGE_MIMES = Object.freeze({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' });

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function safeHref(value) {
  const candidate = String(value || '').trim();
  if (candidate.startsWith('/') && !candidate.startsWith('//') && !/[\s\\]/u.test(candidate)) return candidate;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function renderInlineMarkdown(value) {
  const links = [];
  const tokenized = String(value || '').replace(/\[([^\]]+)\]\(([^)]+)\)/gu, (match, label, href) => {
    const safe = safeHref(href);
    if (!safe) return label;
    const token = `ALEXANDRELINKTOKEN${links.length}END`;
    links.push(`<a href="${escapeHtml(safe)}">${escapeHtml(label)}</a>`);
    return token;
  });
  let html = escapeHtml(tokenized)
    .replace(/`([^`]+)`/gu, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/gu, '<em>$1</em>');
  links.forEach((link, index) => { html = html.replace(`ALEXANDRELINKTOKEN${index}END`, link); });
  return html;
}

export function markdownBlocks(markdown) {
  const blocks = [];
  const paragraph = [];
  const lines = String(markdown || '').replaceAll('\r\n', '\n').split('\n');
  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ kind: 'paragraph', html: `<p>${renderInlineMarkdown(paragraph.join(' '))}</p>` });
    paragraph.length = 0;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      flushParagraph();
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.+)$/u);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: 'heading', html: `<h3>${renderInlineMarkdown(heading[1])}</h3>` });
      continue;
    }
    if (/^>\s?/u.test(line)) {
      flushParagraph();
      blocks.push({ kind: 'paragraph', html: `<blockquote><p>${renderInlineMarkdown(line.replace(/^>\s?/u, ''))}</p></blockquote>` });
      continue;
    }
    if (/^(?:[-*]|\d+\.)\s+/u.test(line)) {
      flushParagraph();
      const ordered = /^\d+\./u.test(line);
      const items = [];
      while (index < lines.length) {
        const item = lines[index].trim();
        const match = ordered ? item.match(/^\d+\.\s+(.+)$/u) : item.match(/^[-*]\s+(.+)$/u);
        if (!match) break;
        items.push(`<li>${renderInlineMarkdown(match[1])}</li>`);
        index += 1;
      }
      index -= 1;
      const tag = ordered ? 'ol' : 'ul';
      blocks.push({ kind: 'list', html: `<${tag}>${items.join('')}</${tag}>` });
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}

function chunkBlocks(blocks, count) {
  const chunks = Array.from({ length: count }, () => []);
  blocks.forEach((block, index) => {
    chunks[Math.min(count - 1, Math.floor((index * count) / Math.max(1, blocks.length)))].push(block);
  });
  return chunks;
}

function paragraph(value) {
  return `<p>${renderInlineMarkdown(String(value || '').trim())}</p>`;
}

function sourceList(sourceUrls) {
  const items = [...new Set((sourceUrls || []).map(safeHref).filter(Boolean))];
  if (!items.length) return '';
  return `<ul>${items.map((url, index) => `<li><a href="${escapeHtml(url)}">Source ${index + 1}</a></li>`).join('')}</ul>`;
}

function section(heading, blocks) {
  return `<h2>${escapeHtml(heading)}</h2>\n${blocks.map((block) => typeof block === 'string' ? block : block.html).join('\n')}`;
}

export function renderWordPressContent(draft) {
  const headings = EDITORIAL_HEADINGS[draft?.contentType];
  if (!headings) throw new Error(`Type WordPress non pris en charge: ${draft?.contentType}`);
  const blocks = markdownBlocks(draft.body);
  if (!blocks.length) throw new Error('Corps éditorial vide');
  if (draft.contentType === 'news') {
    const chunks = chunkBlocks(blocks, 3);
    return [
      section(headings[0], chunks[0].length ? chunks[0] : [paragraph(draft.description)]),
      section(headings[1], chunks[1].length ? chunks[1] : [paragraph((draft.keyPoints || [])[0] || draft.description)]),
      section(headings[2], chunks[2].length ? chunks[2] : [paragraph((draft.keyPoints || [])[1] || draft.description)]),
      section(headings[3], [
        paragraph('Les informations ont été vérifiées à partir des sources ci-dessous.'),
        paragraph('Les faits confirmés sont distingués des analyses et des limites encore ouvertes.'),
        sourceList(draft.sourceUrls),
      ]),
    ].join('\n');
  }
  if (draft.contentType === 'video') {
    const firstParagraph = blocks.findIndex((block) => block.kind === 'paragraph');
    const splitAt = Math.min(blocks.length, Math.max(firstParagraph + 2, 2));
    const brief = blocks.slice(0, splitAt);
    const detail = blocks.slice(splitAt);
    return [
      section(headings[0], brief.length ? brief : [paragraph(draft.description)]),
      section(headings[1], detail.length ? detail : [paragraph(draft.description)]),
      section(headings[2], [paragraph((draft.keyPoints || [])[0] || draft.description)]),
      section(headings[3], [paragraph('Retrouve la vidéo originale et les ressources citées.'), sourceList([
        draft.video?.url,
        ...(draft.sourceUrls || []),
      ])]),
    ].join('\n');
  }
  const faq = Array.isArray(draft.faq) ? draft.faq.filter((item) => item?.question && item?.answer) : [];
  if (!faq.length) throw new Error('Un guide WordPress exige au moins une question fréquente');
  const chunks = chunkBlocks(blocks, 4);
  const faqBlocks = faq.slice(0, 8).flatMap((item) => [
    `<h3>${renderInlineMarkdown(item.question)}</h3>`,
    paragraph(item.answer),
  ]);
  return [
    section(headings[0], chunks[0].length ? chunks[0] : [paragraph(draft.description)]),
    section(headings[1], chunks[1].length ? chunks[1] : [paragraph((draft.keyPoints || [])[0] || draft.description)]),
    section(headings[2], chunks[2].length ? chunks[2] : [paragraph((draft.keyPoints || [])[1] || draft.description)]),
    section(headings[3], chunks[3].length ? chunks[3] : [paragraph((draft.keyPoints || [])[2] || draft.description)]),
    section(headings[4], faqBlocks),
    section(headings[5], [
      paragraph((draft.keyPoints || []).at(-1) || draft.description),
      paragraph('Passe à l’action progressivement et vérifie chaque résultat avant l’étape suivante.'),
      sourceList(draft.sourceUrls),
    ]),
  ].join('\n');
}

function httpsUrls(values) {
  return [...new Set((values || []).map(safeHref).filter((url) => url?.startsWith('https://')))];
}

export function wordpressTarget(draft) {
  const target = WORDPRESS_TARGETS[String(draft?.mediaSlug || '')];
  if (!target) throw new Error(`Média WordPress non pris en charge: ${draft?.mediaSlug}`);
  return target;
}

function publicPath(draft, target) {
  const routes = { news: target.newsRoute, video: 'videos', guide: 'guides' };
  const route = routes[draft.contentType];
  if (!route || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(String(draft.slug || ''))) throw new Error('Slug WordPress invalide');
  return `/${route}/${draft.slug}/`;
}

export function withVerifiedSourceDate(store, draft) {
  if (draft?.contentType !== 'news' || Number.isFinite(Date.parse(draft.sourcePublishedAt || ''))) return draft;
  const queueId = `${draft.mediaSlug}-${draft.candidateId}`;
  const candidate = readJson(store.queuePath('qualified', queueId), null)
    || readJson(store.queuePath('candidates', queueId), null);
  const sourceUrls = new Set(httpsUrls(draft.sourceUrls));
  const matchingOfficialSource = (candidate?.sources || []).find((source) => (
    source?.official === true
    && sourceUrls.has(safeHref(source.url))
    && Number.isFinite(Date.parse(source.publishedAt || ''))
  ));
  const publishedAt = candidate?.publishedAt || matchingOfficialSource?.publishedAt;
  if (!matchingOfficialSource || !Number.isFinite(Date.parse(publishedAt || ''))) return draft;
  return { ...draft, sourcePublishedAt: new Date(publishedAt).toISOString() };
}

export function payloadForWordPressDraft(draft, { featuredMediaId = 0 } = {}) {
  const target = wordpressTarget(draft);
  if (!draft?.qa?.passed) throw new Error('Le brouillon doit avoir passé la QA');
  const postType = { news: target.newsType, video: 'video', guide: 'guide' }[draft.contentType];
  if (!postType) throw new Error(`Type WordPress non pris en charge: ${draft.contentType}`);
  const routePath = publicPath(draft, target);
  const sourceUrls = httpsUrls(draft.sourceUrls);
  if (draft.contentType === 'news' && (!sourceUrls.length || !Number.isFinite(Date.parse(draft.sourcePublishedAt || '')))) {
    throw new Error('Une actualité WordPress exige ses sources et leur date de publication');
  }
  const videoId = String(draft.video?.videoId || '');
  const youtubeUrl = safeHref(draft.video?.url || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : ''));
  if (draft.contentType === 'video' && (!/^[A-Za-z0-9_-]{11}$/u.test(videoId) || !youtubeUrl)) {
    throw new Error('Un article vidéo WordPress exige une vidéo YouTube valide');
  }
  const content = renderWordPressContent(draft);
  const candidateId = `media-engine:${draft.mediaSlug}:${draft.contentType}:${draft.candidateId}`;
  const payload = {
    candidate_id: candidateId,
    content_type: postType,
    status: 'draft',
    title: String(draft.title || '').trim(),
    slug: draft.slug,
    content,
    excerpt: String(draft.description || '').trim(),
    featured_media: Number.isInteger(featuredMediaId) && featuredMediaId > 0 ? featuredMediaId : 0,
    category_ids: [],
    tag_ids: [],
    site_key: target.siteKey,
    media_slug: draft.mediaSlug,
    editorial_contract_version: '1.0.0',
    source_id: String(draft.candidateId || ''),
    source_urls: sourceUrls,
    source_status: 'qa-passed',
    content_hash: createHash('sha256').update(content).digest('hex'),
    public_path: routePath,
    canonical_url: `https://${target.domain}${routePath}`,
    seo_title: String(draft.title || '').trim(),
    meta_description: String(draft.description || '').trim(),
    generated_at: draft.generatedAt || '',
    scheduled_publish_at: draft.scheduledPublishAt || '',
    word_count: Number.isInteger(draft.wordCount) ? draft.wordCount : 0,
    qa_passed: true,
  };
  if (draft.contentType === 'news') payload.source_published_at = new Date(draft.sourcePublishedAt).toISOString();
  if (draft.contentType === 'video') {
    payload.youtube_video_id = videoId;
    payload.youtube_url = youtubeUrl;
    payload.transcript_hash = draft.video?.transcriptHash || '';
    payload.media_credit = 'Miniature officielle YouTube';
  }
  const affiliateUrl = safeHref(draft.offer?.url);
  if (affiliateUrl?.startsWith('https://')) {
    payload.affiliate_url = affiliateUrl;
    payload.affiliate_program = String(draft.offer?.name || '').trim();
    payload.affiliate_cta = `Découvrir ${String(draft.offer?.name || 'la ressource').trim()}`;
    payload.disclosure = 'Ce contenu peut contenir un lien affilié. Une commission peut être versée sans surcoût pour vous.';
  }
  return payload;
}

export function assetForWordPressDraft(draft, { includeBytes = true } = {}) {
  wordpressTarget(draft);
  if (!['news', 'guide'].includes(draft.contentType)) return null;
  const bannerPath = String(draft.banner?.path || '').trim();
  if (!bannerPath) throw new Error('La bannière locale du brouillon est introuvable');
  const path = resolve(bannerPath);
  if (!existsSync(path)) throw new Error('La bannière locale du brouillon est introuvable');
  const mime = IMAGE_MIMES[extname(path).toLowerCase()];
  if (!mime) throw new Error('Le format de bannière WordPress doit être JPEG, PNG ou WebP');
  const bytes = readFileSync(path);
  if (!bytes.length || bytes.length > WORDPRESS_ASSET_MAX_BYTES) throw new Error('La bannière WordPress dépasse la limite de 3 Mo');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const asset = {
    asset_id: `media-engine:${draft.mediaSlug}:${draft.contentType}:${draft.candidateId}:banner`,
    filename: basename(path),
    mime,
    sha256,
    byte_length: bytes.length,
    alt: String(draft.banner?.alt || draft.title || '').trim(),
  };
  if (includeBytes) asset.bytes_base64 = bytes.toString('base64');
  return asset;
}

export function endpointOrigin(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('URL WordPress HTTPS invalide');
  url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return url.href;
}

export function enabledWordPressMediaSlugs(env = process.env) {
  const raw = String(env.WORDPRESS_DRAFT_MEDIA_SLUGS || 'chaimbault');
  const slugs = [...new Set(raw.split(',').map((value) => value.trim()).filter(Boolean))];
  if (!slugs.length || slugs.some((slug) => !WORDPRESS_TARGETS[slug])) {
    throw new Error('WORDPRESS_DRAFT_MEDIA_SLUGS contient un média non pris en charge');
  }
  return slugs;
}

export function wordpressSiteUrls(env = process.env) {
  const baseUrl = endpointOrigin(env.WORDPRESS_DRAFT_BASE_URL);
  let overrides = {};
  if (env.WORDPRESS_DRAFT_SITE_URLS_JSON) {
    try { overrides = JSON.parse(env.WORDPRESS_DRAFT_SITE_URLS_JSON); } catch { throw new Error('WORDPRESS_DRAFT_SITE_URLS_JSON doit être un objet JSON valide'); }
    if (!overrides || Array.isArray(overrides) || typeof overrides !== 'object') throw new Error('WORDPRESS_DRAFT_SITE_URLS_JSON doit être un objet JSON valide');
    for (const [slug, url] of Object.entries(overrides)) {
      if (!WORDPRESS_TARGETS[slug]) throw new Error(`URL WordPress fournie pour un média inconnu: ${slug}`);
      overrides[slug] = endpointOrigin(url);
    }
  }
  return Object.fromEntries(Object.entries(WORDPRESS_TARGETS).map(([slug, target]) => [
    slug,
    overrides[slug] || new URL(target.stagingPath.replace(/^\//u, ''), baseUrl).href,
  ]));
}

export class WordPressDraftClient {
  constructor({ baseUrl, username, applicationPassword, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
    this.baseUrl = endpointOrigin(baseUrl);
    if (!username || !applicationPassword) throw new Error('Identifiants WordPress Application Password absents');
    this.authorization = `Basic ${Buffer.from(`${username}:${applicationPassword}`).toString('base64')}`;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(path, options = {}) {
	const relativePath = String(path || '').replace(/^\/+/, '');
	if (!relativePath) throw new Error('Chemin WordPress vide');
	const response = await this.fetchImpl(new URL(relativePath, this.baseUrl), {
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
      ...options,
      headers: {
        accept: 'application/json',
        authorization: this.authorization,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    const raw = await response.text();
    if (raw.length > 1_048_576) throw new Error('Réponse WordPress trop volumineuse');
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`Réponse WordPress non JSON (HTTP ${response.status})`); }
    if (!response.ok) throw new Error(`WordPress HTTP ${response.status}: ${body.code || 'erreur-inconnue'}`);
    return { status: response.status, body };
  }

  health() {
    return this.request('/wp-json/alexandre-network/v1/health');
  }

  createDraft(payload) {
    return this.request('/wp-json/alexandre-network/v1/drafts', { method: 'POST', body: JSON.stringify(payload) });
  }

  uploadAsset(payload) {
    const { byte_length: byteLength, ...body } = payload;
    if (byteLength !== Buffer.byteLength(body.bytes_base64 || '', 'base64')) throw new Error('La taille de l’asset WordPress a changé avant envoi');
    return this.request('/wp-json/alexandre-network/v1/assets', { method: 'POST', body: JSON.stringify(body) });
  }
}

export class WordPressDraftPublisher {
  constructor({ store, client = null, env = process.env, now = () => new Date() } = {}) {
    if (!store) throw new Error('MediaStateStore requis');
    this.store = store;
    this.env = env;
    this.now = now;
    this.client = client;
  }

  clientForWrite(draft) {
	return this.clientForMedia(draft.mediaSlug);
  }

  clientForMedia(mediaSlug) {
    if (this.client) return this.client;
    const urls = wordpressSiteUrls(this.env);
    return new WordPressDraftClient({
	  baseUrl: urls[mediaSlug],
      username: this.env.WORDPRESS_DRAFT_USERNAME,
      applicationPassword: this.env.WORDPRESS_DRAFT_APPLICATION_PASSWORD,
    });
  }

  async healthForMedia(mediaSlug) {
	const target = WORDPRESS_TARGETS[mediaSlug];
	if (!target) throw new Error(`Média WordPress non pris en charge: ${mediaSlug || '(vide)'}`);
	const response = await this.clientForMedia(mediaSlug).health();
	const health = response.body || {};
	if (
	  health.status !== 'ok'
	  || health.site_key !== target.siteKey
	  || health.publication_mode !== 'draft-only'
	  || health.can_publish !== false
	  || health.can_delete !== false
	) {
	  throw new Error(`Le endpoint WordPress ${target.siteKey} n’est pas en mode brouillon sûr`);
	}
	return {
	  status: health.status,
	  siteKey: health.site_key,
	  blogId: Number(health.blog_id || 0),
	  publicationMode: health.publication_mode,
	  canPublish: health.can_publish,
	  canDelete: health.can_delete,
	};
  }

  async healthForAutomaticPublication(mediaSlug) {
	const target = WORDPRESS_TARGETS[mediaSlug];
	if (!target) throw new Error(`Média WordPress non pris en charge: ${mediaSlug || '(vide)'}`);
	const response = await this.clientForMedia(mediaSlug).health();
	const health = response.body || {};
	if (
	  health.status !== 'ok'
	  || health.site_key !== target.siteKey
	  || health.publication_mode !== 'auto-publish'
	  || health.can_publish !== true
	  || health.can_delete !== false
	) {
	  throw new Error(`Le endpoint WordPress ${target.siteKey} n’est pas prêt pour la publication automatique`);
	}
	return {
	  status: health.status,
	  siteKey: health.site_key,
	  blogId: Number(health.blog_id || 0),
	  publicationMode: health.publication_mode,
	  canPublish: health.can_publish,
	  canDelete: health.can_delete,
	};
  }

  async publishAutomaticDraftPath(draftPath, { dryRun = false } = {}) {
	const absoluteDraftPath = resolve(draftPath);
	if (!existsSync(absoluteDraftPath)) throw new Error(`Brouillon introuvable: ${absoluteDraftPath}`);
	let draft = readJson(absoluteDraftPath, null);
	if (!draft) throw new Error('Brouillon JSON invalide');
	draft = withVerifiedSourceDate(this.store, draft);
	if (draft.publicationEligibility?.status !== 'eligible') {
	  throw new Error('Seuls les brouillons éligibles sont publiés');
	}
	const payload = payloadForWordPressDraft(draft);
	if (dryRun) return { dryRun: true, draftPath: absoluteDraftPath, payload };
	const target = wordpressTarget(draft);
	const client = this.clientForWrite(draft);
	await this.healthForAutomaticPublication(draft.mediaSlug);
	const response = await client.createDraft(payload);
	if (
	  response.body?.post_status !== 'publish'
	  || response.body?.publication_mode !== 'auto-publish'
	  || response.body?.published !== true
	) {
	  throw new Error('Le reçu WordPress ne confirme pas la publication');
	}
	const receipt = {
	  version: 1,
	  status: 'published-wordpress',
	  publishedAt: this.now().toISOString(),
	  mediaSlug: draft.mediaSlug,
	  siteKey: target.siteKey,
	  contentType: draft.contentType,
	  candidateId: draft.candidateId,
	  slug: draft.slug,
	  draftPath: absoluteDraftPath,
	  wordpress: response.body,
	};
	const receiptPath = join(this.store.stateDir, 'wordpress-publication-receipts', draft.mediaSlug, `${draft.slug}.json`);
	writeJsonAtomic(receiptPath, receipt);
	return { ...receipt, receiptPath };
  }

  async mirrorDraftPath(draftPath, { dryRun = false, featuredMediaId = 0 } = {}) {
    const absoluteDraftPath = resolve(draftPath);
    if (!existsSync(absoluteDraftPath)) throw new Error(`Brouillon introuvable: ${absoluteDraftPath}`);
    let draft = readJson(absoluteDraftPath, null);
    if (!draft) throw new Error('Brouillon JSON invalide');
    draft = withVerifiedSourceDate(this.store, draft);
    if (draft.publicationEligibility?.status !== 'eligible') throw new Error('Seuls les brouillons éligibles sont envoyés au shadow WordPress');
    const assetManifest = featuredMediaId ? null : assetForWordPressDraft(draft, { includeBytes: false });
    if (dryRun) {
      return {
        dryRun: true,
        draftPath: absoluteDraftPath,
        asset: assetManifest,
        payload: payloadForWordPressDraft(draft, { featuredMediaId }),
      };
    }
	const target = wordpressTarget(draft);
	const client = this.clientForWrite(draft);
	await this.healthForMedia(draft.mediaSlug);
    let assetReceipt = null;
    if (!featuredMediaId && assetManifest) {
      const assetResponse = await client.uploadAsset(assetForWordPressDraft(draft));
      if (assetResponse.body?.status !== 'asset-ready' || assetResponse.body?.publication_mode !== 'draft-only') {
        throw new Error('Le reçu WordPress ne confirme pas un asset de brouillon');
      }
      featuredMediaId = Number(assetResponse.body.attachment_id || 0);
      if (!Number.isInteger(featuredMediaId) || featuredMediaId < 1) throw new Error('Identifiant d’asset WordPress invalide');
      assetReceipt = assetResponse.body;
    }
    const payload = payloadForWordPressDraft(draft, { featuredMediaId });
    const response = await client.createDraft(payload);
    if (!['draft'].includes(response.body?.post_status) || response.body?.publication_mode !== 'draft-only') {
      throw new Error('Le reçu WordPress ne confirme pas un brouillon');
    }
    const receipt = {
      version: 1,
      status: 'draft-mirrored',
      mirroredAt: this.now().toISOString(),
      mediaSlug: draft.mediaSlug,
      siteKey: target.siteKey,
      contentType: draft.contentType,
      candidateId: draft.candidateId,
      draftPath: absoluteDraftPath,
      asset: assetReceipt,
      wordpress: response.body,
    };
    const receiptPath = join(this.store.stateDir, 'wordpress-draft-receipts', draft.mediaSlug, `${draft.slug}.json`);
    writeJsonAtomic(receiptPath, receipt);
    this.store.markEvent(`wordpress-draft:${draft.mediaSlug}:${draft.contentType}:${draft.candidateId}`, receipt);
    return { ...receipt, receiptPath };
  }

  async run({ dryRun = false, limit = 1 } = {}) {
    const results = [];
    const skipped = [];
    const draftPaths = enabledWordPressMediaSlugs(this.env).flatMap((slug) => this.store.listDraftPaths(slug));
    for (const path of draftPaths) {
      if (results.length >= limit) break;
      const draft = readJson(path, null);
      if (!draft?.qa?.passed || draft.publicationEligibility?.status !== 'eligible') continue;
      if (this.store.hasEvent(`wordpress-draft:${draft.mediaSlug}:${draft.contentType}:${draft.candidateId}`)) continue;
      try {
        results.push(await this.mirrorDraftPath(path, { dryRun }));
      } catch (error) {
        skipped.push({
          draftPath: path,
          candidateId: String(draft.candidateId || ''),
          contentType: String(draft.contentType || ''),
          reason: String(error?.message || error).slice(0, 500),
        });
      }
    }
    return { inspected: draftPaths.length, results, skipped };
  }
}
