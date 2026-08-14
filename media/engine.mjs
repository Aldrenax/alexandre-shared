import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { getChannelFeed, getVideoInfo, youtubeThumbnailCandidates } from '../lib/youtube.mjs';
import {
  activeMedia,
  assertValidRegistry,
  MEDIA_ENGINE_DEFAULTS,
  mediaBySlug,
  sourcesForMedia,
} from './registry.mjs';
import { collectSources, enrichCandidateEvidence } from './source-collector.mjs';
import {
  candidateRequiresOfficialEvidence,
  canonicalUrl,
  clusterCandidates,
  findDraftConflict,
  findInternalLinkConflict,
  qualifyCandidate,
  samePersistedNewsEvent,
} from './candidates.mjs';
import {
  ARTICLE_THUMBNAIL_POLICY,
  buildBannerPrompt,
  buildEditorialPrompt,
  buildEditorialRepairPrompt,
  EDITORIAL_REVISION,
  normalizeDraft,
} from './editorial.mjs';
import { qaDraft } from './qa.mjs';
import { guideCandidate, rankGuideOpportunities } from './guide-planner.mjs';
import { HermesClient } from './hermes-client.mjs';
import { MediaStateStore, readJson } from './state-store.mjs';

const X_SNOWFLAKE_EPOCH_MS = 1_288_834_974_657n;
export const EVIDENCE_REVISION = 2;

const EVIDENCE_RETRY_REASONS = new Set([
  'corroboration-accessible-insuffisante',
  'preuve-source-inaccessible',
  'source-officielle-inaccessible',
]);

function normalizedXHandle(value = '') {
  return String(value).trim().replace(/^@/, '').toLowerCase();
}

export function xPostIdentity(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!['x.com', 'twitter.com'].includes(host)) return { handle: null, statusId: null };
    const parts = url.pathname.split('/').filter(Boolean);
    const statusIndex = parts.findIndex((part) => part.toLowerCase() === 'status');
    if (statusIndex < 1 || !/^\d{10,}$/.test(parts[statusIndex + 1] || '')) {
      return { handle: null, statusId: null };
    }
    const handle = normalizedXHandle(parts[statusIndex - 1]);
    return {
      handle: handle === 'i' ? null : handle,
      statusId: parts[statusIndex + 1],
    };
  } catch {
    return { handle: null, statusId: null };
  }
}

export function xSnowflakePublishedAt(statusId, now = new Date()) {
  try {
    const milliseconds = (BigInt(statusId) >> 22n) + X_SNOWFLAKE_EPOCH_MS;
    const value = Number(milliseconds);
    const minimum = Date.parse('2006-03-21T00:00:00.000Z');
    if (!Number.isFinite(value) || value < minimum || value > now.getTime() + 86_400_000) return null;
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

function allowedXHandles(media) {
  return new Set((media.officialXQueries || [])
    .flatMap((search) => search.allowedHandles || [])
    .map(normalizedXHandle)
    .filter(Boolean));
}

export function verifiedOfficialXPost(post, media, explicitHandles = []) {
  const identity = xPostIdentity(post?.url);
  if (!identity.handle) return false;
  const allowed = new Set([
    ...allowedXHandles(media),
    ...explicitHandles.map(normalizedXHandle),
  ]);
  return allowed.has(identity.handle);
}

export function xItems(result, media) {
  if (result.degraded) return [];
  const posts = Array.isArray(result.posts) ? result.posts : [];
  const citations = Array.isArray(result.citations) ? result.citations : [];
  const values = posts.length ? posts : citations.map((citation) => ({
    url: citation.url,
    summary: citation.title || result.answer,
    author: '',
    publishedAt: null,
    official: false,
  }));
  return values.filter((post) => /^https?:\/\//.test(post.url || '')).map((post, index) => {
    const identity = xPostIdentity(post.url);
    const official = verifiedOfficialXPost(post, media, result.allowedHandles || []);
    return {
      id: `x:${media.slug}:${index}:${post.url}`,
      sourceId: 'x-search',
      sourceTier: official ? 1 : 3,
      sourceOfficial: official,
      title: post.summary || result.answer || result.query,
      url: post.url,
      excerpt: post.summary || result.answer || '',
      publishedAt: post.publishedAt || xSnowflakePublishedAt(identity.statusId) || null,
      author: post.author || '',
      media: [media.slug],
      kind: 'x-search',
    };
  });
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const REPAIRABLE_QA_ISSUES = new Set([
  'word-count-low',
  'description-invalid',
  'h1-forbidden',
  'typography-dash',
  'section-invalid',
  'category-invalid',
  'guide-topic-invalid',
  'source-link-missing',
  'claims-missing',
  'claim-empty',
  'claim-unsourced',
  'claim-source-unknown',
  'finance-disclaimer-missing',
  'capital-risk-missing',
  'legal-tax-disclaimer-missing',
  'affiliate-disclosure-missing',
  'affiliate-link-missing',
]);

export function qaCanBeRepaired(qa) {
  const errors = (qa?.issues || []).filter((entry) => entry.severity === 'error');
  return errors.length > 0 && errors.every((entry) => REPAIRABLE_QA_ISSUES.has(entry.code));
}

function qaRepairLimit(env = process.env) {
  const parsed = Number.parseInt(env.MEDIA_ENGINE_QA_REPAIR_ATTEMPTS ?? '1', 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(2, Math.max(0, parsed));
}

function plausibleVideoDate(value, now = Date.now()) {
  const date = value instanceof Date ? value : new Date(value || '');
  return Number.isFinite(date.getTime())
    && date.getTime() >= Date.parse('2005-02-14T00:00:00.000Z')
    && date.getTime() <= now + 24 * 3_600_000
    ? date
    : null;
}

function xSearchPolicy(env = process.env) {
  return {
    enabled: String(env.MEDIA_ENGINE_X_SEARCH_ENABLED || 'true').toLowerCase() !== 'false',
    officialOnly: String(env.MEDIA_ENGINE_X_SEARCH_OFFICIAL_ONLY || 'true').toLowerCase() !== 'false',
    maxQueries: positiveInteger(env.MEDIA_ENGINE_X_SEARCH_MAX_QUERIES, 6),
    intervalHours: positiveInteger(env.MEDIA_ENGINE_X_SEARCH_INTERVAL_HOURS, 168),
    quotaCooldownHours: positiveInteger(env.MEDIA_ENGINE_X_SEARCH_QUOTA_COOLDOWN_HOURS, 168),
  };
}

function quotaExceeded(value = '') {
  return /(quota|weekly\s+limit|limite\s+hebdomadaire|limite.*semaine|usage\s+limit)/i.test(String(value));
}

const HERMES_CONTAINER_IMAGE_ROOT = '/opt/data/cache/images';
const DEFAULT_HERMES_HOST_IMAGE_ROOT = '/var/lib/hermes-agent/cache/images';
const MAX_BANNER_BYTES = 30 * 1024 * 1024;

function localHermesImageBuffer(imageSource, hostRoot) {
  let relativePath;
  if (imageSource.startsWith(`${HERMES_CONTAINER_IMAGE_ROOT}/`)) {
    relativePath = imageSource.slice(HERMES_CONTAINER_IMAGE_ROOT.length + 1);
  } else if (imageSource.startsWith(`${hostRoot}/`)) {
    relativePath = imageSource.slice(hostRoot.length + 1);
  } else {
    throw new Error('Source locale de bannière hors cache Hermes');
  }

  const realRoot = realpathSync(hostRoot);
  const requestedPath = resolve(realRoot, relativePath);
  const realPath = realpathSync(requestedPath);
  if (!realPath.startsWith(`${realRoot}${sep}`)) throw new Error('Source locale de bannière hors cache Hermes');
  const stats = statSync(realPath);
  if (!stats.isFile()) throw new Error('Source locale de bannière non fichier');
  if (stats.size > MAX_BANNER_BYTES) throw new Error(`Bannière trop volumineuse: ${stats.size} octets`);
  return readFileSync(realPath);
}

async function bannerBuffer(imageSource, fetchImpl, { hermesHostImageRoot } = {}) {
  if (typeof imageSource !== 'string' || !imageSource.trim()) throw new Error('Source de bannière Hermes invalide');
  const source = imageSource.trim();
  if (/^https?:\/\//.test(source)) {
    const response = await fetchImpl(source, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Téléchargement bannière HTTP ${response.status}`);
    const contentLength = Number(response.headers?.get?.('content-length') || 0);
    if (contentLength > MAX_BANNER_BYTES) throw new Error(`Bannière trop volumineuse: ${contentLength} octets`);
    return Buffer.from(await response.arrayBuffer());
  }
  const dataMatch = source.match(/^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i);
  if (dataMatch) {
    const buffer = Buffer.from(dataMatch[1].replace(/\s/g, ''), 'base64');
    if (buffer.length > MAX_BANNER_BYTES) throw new Error(`Bannière trop volumineuse: ${buffer.length} octets`);
    return buffer;
  }
  return localHermesImageBuffer(
    source,
    hermesHostImageRoot || process.env.HERMES_IMAGE_CACHE_DIR || DEFAULT_HERMES_HOST_IMAGE_ROOT,
  );
}

async function materializeBanner(imageSource, destination, fetchImpl = fetch, options = {}) {
  const buffer = await bannerBuffer(imageSource, fetchImpl, options);
  if (buffer.length < 8_000) throw new Error(`Bannière anormalement petite: ${buffer.length} octets`);
  let sharp;
  try {
    ({ default: sharp } = await import('sharp'));
  } catch {
    throw new Error('sharp est requis pour normaliser la bannière en 1200x630 WebP');
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o750 });
  const temporary = `${destination}.${process.pid}.tmp`;
  await sharp(buffer)
    .resize(1_200, 630, { fit: 'cover', position: 'attention' })
    .webp({ quality: 84 })
    .toFile(temporary);
  renameSync(temporary, destination);
  return destination;
}

async function downloadAsset(url, destination, fetchImpl = fetch) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Téléchargement asset HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 8_000) throw new Error(`Asset anormalement petit: ${buffer.length} octets`);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o750 });
  const temporary = `${destination}.${process.pid}.tmp`;
  writeFileSync(temporary, buffer, { mode: 0o640 });
  renameSync(temporary, destination);
  return destination;
}

export async function downloadFirstAvailableAsset(candidates, destination, fetchImpl = fetch) {
  const errors = [];
  for (const candidate of candidates) {
    try {
      await downloadAsset(candidate.url, destination, fetchImpl);
      return candidate;
    } catch (error) {
      errors.push(`${candidate.url}: ${String(error?.message || error)}`);
    }
  }
  throw new Error(`Aucun asset YouTube exploitable\n${errors.join('\n')}`);
}

export function publishedVideoPath(internalLinks = [], videoId = '') {
  const normalizedId = String(videoId).trim().toLowerCase();
  if (!normalizedId) return null;
  const link = internalLinks.find((entry) => {
    const value = typeof entry === 'string' ? entry : entry?.path || entry?.url || '';
    return String(value).toLowerCase().includes(normalizedId);
  });
  return typeof link === 'string' ? link : link?.path || link?.url || null;
}

export function offerForUrl(offers, mediaSlug, rawUrl) {
  if (!rawUrl) return null;
  let observed;
  try { observed = new URL(rawUrl); } catch { return null; }
  const normalizedPath = (url) => url.pathname.replace(/\/+$/, '') || '/';
  const eligible = offers.filter((offer) => offer.channels?.includes(mediaSlug)
    && offer.status === 'active'
    && /^https?:\/\//.test(offer.url || ''));
  const exact = eligible.find((offer) => {
    const candidate = new URL(offer.url);
    return candidate.origin === observed.origin && normalizedPath(candidate) === normalizedPath(observed);
  });
  if (exact) return exact;
  const sameHost = eligible.filter((offer) => new URL(offer.url).hostname.replace(/^www\./, '')
    === observed.hostname.replace(/^www\./, ''));
  return sameHost.length === 1 ? sameHost[0] : null;
}

export function shouldGenerateDraftForEvent(store, key, revision = EDITORIAL_REVISION) {
  const event = store.getEvent(key);
  if (!event) return true;
  if (event.status === 'retryable-failure') {
    // Une nouvelle stratégie de preuve doit pouvoir reprendre immédiatement
    // les candidats différés par l'ancienne version. Le re-traitement reste
    // unique : le nouveau reçu persiste ensuite la révision courante.
    if (EVIDENCE_RETRY_REASONS.has(event.reason)
      && event.evidenceRevision !== EVIDENCE_REVISION) return true;
    if (['transcript-incomplete-caption-requested', 'transcript-unavailable-caption-requested'].includes(event.reason)
      && key.startsWith('video-draft:')) {
      const videoId = key.split(':').at(-1);
      const request = readJson(join(store.queueDir, 'caption-requests', `${videoId}.json`), null);
      if (request?.status === 'complete') return true;
    }
    return !event.nextRetryAt || Number.isNaN(Date.parse(event.nextRetryAt)) || Date.parse(event.nextRetryAt) <= Date.now();
  }
  // Les versions antérieures perdaient le motif des blocages éditoriaux. Une
  // reprise unique permet de les reclasser comme doublon, déjà publié ou vrai
  // blocage; le nouveau reçu conserve ensuite le motif et reste idempotent.
  if (event.status === 'editorial-blocked' && (
    !event.reason
    || transcriptBlockNeedsCaption(event.reason)
    || (Number.isFinite(event.editorialRevision) && event.editorialRevision !== revision)
  )) return true;
  return event.status === 'qa-failed' && event.editorialRevision !== revision;
}

export function transcriptBlockNeedsCaption(reason = '') {
  const value = String(reason);
  return /(transcript|transcription|sous-titres)/i.test(value)
    && /(incompl|tronqu|manqu|partial|incomplete|truncat)/i.test(value);
}

export function videoDraftReceipt(draft, candidateId) {
  if (draft?.qa?.passed) {
    return { status: 'qa-passed', editorialRevision: EDITORIAL_REVISION, candidateId };
  }
  if (draft?.status === 'blocked') {
    if (draft.reason === 'already-published-or-similar') {
      return {
        status: 'already-published',
        reason: draft.reason,
        path: draft.publishedPath || null,
        editorialRevision: EDITORIAL_REVISION,
        candidateId,
      };
    }
    if (String(draft.reason || '').startsWith('duplicate-draft:')) {
      return {
        status: 'duplicate-draft',
        reason: draft.reason,
        path: draft.duplicateDraftPath || null,
        editorialRevision: EDITORIAL_REVISION,
        candidateId,
      };
    }
    return {
      status: 'editorial-blocked',
      reason: draft.reason || 'motif non fourni',
      editorialRevision: EDITORIAL_REVISION,
      candidateId,
    };
  }
  return {
    status: 'qa-failed',
    reason: draft?.qa?.issues?.map((issue) => issue.code).filter(Boolean).join(', ') || 'qa-failed',
    editorialRevision: EDITORIAL_REVISION,
    candidateId,
  };
}

function retryAt(hours) {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

function validTimestamp(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function candidateObservedAt(candidate) {
  const xIdentity = (candidate.sources || [])
    .map((source) => xPostIdentity(source?.url))
    .find((identity) => identity.statusId);
  const values = [
    candidate.publishedAt,
    ...(candidate.sources || []).map((source) => source?.publishedAt),
    xSnowflakePublishedAt(xIdentity?.statusId),
  ];
  const timestamps = values.map(validTimestamp).filter((value) => value != null);
  if (timestamps.length) return Math.max(...timestamps);
  // Une première observation, un mtime ou un lastSeenAt ne prouvent pas la
  // date de publication d'une actualité. Les contenus non datés restent des
  // sources de guides, mais ne passent jamais dans la cadence quotidienne.
  return null;
}

export function candidateIsFresh(candidate, {
  now = new Date(),
  maximumAgeHours = MEDIA_ENGINE_DEFAULTS.candidateMaxAgeHours || 72,
} = {}) {
  const observedAt = candidateObservedAt(candidate);
  if (observedAt == null) return false;
  return observedAt <= now.getTime() + 86_400_000
    && observedAt >= now.getTime() - maximumAgeHours * 3_600_000;
}

function sanitizePersistedXEvidence(candidate, media) {
  return {
    ...candidate,
    sources: (candidate.sources || []).map((source) => {
      if (source?.sourceId !== 'x-search' && source?.kind !== 'x-search') return source;
      const official = verifiedOfficialXPost(source, media);
      const identity = xPostIdentity(source.url);
      return {
        ...source,
        official,
        tier: official ? 1 : Math.max(3, Number(source.tier) || 3),
        publishedAt: source.publishedAt || xSnowflakePublishedAt(identity.statusId) || null,
      };
    }),
  };
}

export function normalizeEnrichedXEvidence(candidate, media, originalCandidate = candidate) {
  const sources = (candidate.sources || []).map((source) => {
    if (source?.sourceId !== 'x-search' && source?.kind !== 'x-search') return source;
    const verifiedOfficial = Boolean(source.official) && verifiedOfficialXPost(source, media);
    const originalSource = (originalCandidate.sources || []).find((value) => value?.sourceId === source.sourceId
      && canonicalUrl(value?.url) === canonicalUrl(source.url));
    const structuredExcerpt = String(originalSource?.excerpt || '').trim();
    if (verifiedOfficial && structuredExcerpt.length >= 80) {
      return {
        ...source,
        excerpt: structuredExcerpt,
        evidenceStatus: 'available',
        evidenceKind: 'verified-x-search-post',
        evidenceRetrievedAt: candidate.evidenceEnrichedAt || new Date().toISOString(),
        evidenceError: undefined,
      };
    }
    // Le HTML public de X peut n'être qu'une coquille JavaScript ou une page
    // de connexion. Aucune entrée X non vérifiée ne peut donc compter comme
    // preuve secondaire accessible dans un cycle de publication automatique.
    return {
      ...source,
      official: false,
      tier: Math.max(3, Number(source.tier) || 3),
      evidenceStatus: 'unavailable',
      evidenceKind: 'unverified-x-html-rejected',
      evidenceError: 'Post X non vérifiable dans les données structurées',
    };
  });
  return {
    ...candidate,
    sources,
    evidenceAvailableCount: sources.filter((source) => source.evidenceStatus === 'available').length,
  };
}

function candidatePoolKey(candidate) {
  return `${candidate.mediaSlug}:${candidate.id || canonicalUrl(candidate.primaryUrl || '')}`;
}

function persistedSourceKey(source = {}) {
  const itemId = source.itemId ?? source.id;
  if (source.kind === 'official-api' && source.sourceId && itemId != null) {
    return `${source.sourceId}:${itemId}`;
  }
  return canonicalUrl(source.url);
}

function candidateSort(left, right) {
  const score = Number(right.score || 0) - Number(left.score || 0);
  if (score) return score;
  const topics = Number(right.keywordMatches?.length || 0) - Number(left.keywordMatches?.length || 0);
  if (topics) return topics;
  return candidateObservedAt(right) - candidateObservedAt(left);
}

export function buildQualifiedCandidatePool({
  currentCandidates = [],
  queueEntries = [],
  media = [],
  offers = [],
  now = new Date(),
  minimumScore = MEDIA_ENGINE_DEFAULTS.minimumCandidateScore || 70,
  maximumAgeHours = MEDIA_ENGINE_DEFAULTS.candidateMaxAgeHours || 72,
} = {}) {
  const mediaMap = new Map(media.map((item) => [item.slug, item]));
  const values = [];
  const queuedItemsByMedia = new Map();
  const queuedOriginsByMedia = new Map();
  for (const entry of queueEntries) {
    const payload = entry?.payload;
    const target = mediaMap.get(payload?.mediaSlug);
    if (!target || !candidateIsFresh(payload, { now, maximumAgeHours })) continue;
    const sanitized = sanitizePersistedXEvidence(payload, target);
    // Un ancien candidat déjà multi-source conserve son identité historique,
    // mais ses preuves doivent toujours décrire le même événement selon la
    // règle stricte actuelle. Une ancienne fusion ambiguë est exclue plutôt
    // que séparée en deux eventKeys concurrents.
    if ((sanitized.sources || []).length > 1) {
      const sameEvent = sanitized.sources.every((source, index, sources) => sources
        .slice(index + 1)
        .every((other) => samePersistedNewsEvent(source, other, target)));
      if (!sameEvent) continue;
      const requalified = qualifyCandidate(sanitized, target, {
        offers,
        now,
        minimumScore,
        maxAgeHours: maximumAgeHours,
      });
      if (requalified.status === 'qualified') {
        values.push({ ...requalified, firstSeenAt: payload.firstSeenAt, lastSeenAt: payload.lastSeenAt });
      }
      continue;
    }
    const queuedItems = queuedItemsByMedia.get(target.slug) || [];
    const queuedOrigins = queuedOriginsByMedia.get(target.slug) || new Map();
    for (const source of sanitized.sources || []) {
      const url = source?.url || sanitized.primaryUrl;
      if (!url) continue;
      queuedItems.push({
        id: source.itemId || `${sanitized.id}:${source.sourceId || canonicalUrl(url)}`,
        sourceId: source.sourceId,
        sourceTier: Number(source.tier),
        sourceOfficial: Boolean(source.official),
        title: source.title || sanitized.title,
        url,
        excerpt: source.excerpt || '',
        publishedAt: source.publishedAt || sanitized.publishedAt || null,
        media: [target.slug],
        kind: source.kind || 'news',
      });
      const origin = {
        id: sanitized.id,
        firstSeenAt: validTimestamp(payload.firstSeenAt)
          ?? validTimestamp(payload.qualifiedAt)
          ?? Number.MAX_SAFE_INTEGER,
      };
      const originKey = persistedSourceKey({ ...source, url });
      const currentOrigin = queuedOrigins.get(originKey);
      if (!currentOrigin
        || origin.firstSeenAt < currentOrigin.firstSeenAt
        || (origin.firstSeenAt === currentOrigin.firstSeenAt && origin.id < currentOrigin.id)) {
        queuedOrigins.set(originKey, origin);
      }
    }
    queuedItemsByMedia.set(target.slug, queuedItems);
    queuedOriginsByMedia.set(target.slug, queuedOrigins);
  }
  // Les candidats mono-source persistés ont parfois été créés séparément parce
  // que leurs flux n'étaient pas modifiés au même cycle. On les regroupe en
  // complete-link : chaque source doit correspondre à toutes les autres. Cela
  // évite les chaînes transitives A~B~C et les collisions d'identité héritées.
  for (const [mediaSlug, queuedItems] of queuedItemsByMedia.entries()) {
    const target = mediaMap.get(mediaSlug);
    const queuedOrigins = queuedOriginsByMedia.get(mediaSlug) || new Map();
    const groups = [];
    const uniqueItems = [...new Map(queuedItems
      .map((item) => [item.kind === 'official-api' && item.sourceId && item.id != null
        ? `${item.sourceId}:${item.id}`
        : canonicalUrl(item.url), item])).values()]
      .sort((left, right) => canonicalUrl(left.url).localeCompare(canonicalUrl(right.url)));
    for (const item of uniqueItems) {
      const group = groups.find((candidate) => candidate
        .every((existing) => samePersistedNewsEvent(existing, item, target)));
      if (group) group.push(item);
      else groups.push([item]);
    }
    for (const group of groups) {
      const cluster = clusterCandidates(group, -1)[0];
      const origins = [...new Map(cluster.sources
        .map((source) => queuedOrigins.get(persistedSourceKey(source)))
        .filter(Boolean)
        .map((origin) => [origin.id, origin])).values()]
        .sort((left, right) => left.firstSeenAt - right.firstSeenAt || left.id.localeCompare(right.id));
      // Le premier candidat observé reste l'identité stable du sujet. Ajouter
      // ensuite une source de meilleur tier ne change donc ni l'eventKey ni
      // l'historique de retry/idempotence.
      if (origins.length) cluster.id = origins[0].id;
      const requalified = qualifyCandidate(cluster, target, {
        offers,
        now,
        minimumScore,
        maxAgeHours: maximumAgeHours,
      });
      if (requalified.status === 'qualified') values.push(requalified);
    }
  }
  for (const candidate of currentCandidates) {
    if (candidate.status !== 'qualified' || !mediaMap.has(candidate.mediaSlug)) continue;
    if (!candidateIsFresh(candidate, { now, maximumAgeHours })) continue;
    values.push(candidate);
  }
  const deduped = new Map();
  for (const candidate of values.sort(candidateSort)) {
    const key = candidatePoolKey(candidate);
    if (!deduped.has(key)) deduped.set(key, candidate);
  }
  // Le dédoublonnage reste strictement intra-média. Une annonce réellement
  // pertinente pour deux verticales peut recevoir deux angles distincts ; les
  // faux routages inter-sites sont déjà éliminés par le matching borné.
  return [...deduped.values()].sort(candidateSort);
}

export function pendingEligibleNewsDraft(store, mediaSlug, {
  now = new Date(),
  maximumAgeHours = MEDIA_ENGINE_DEFAULTS.candidateMaxAgeHours || 72,
} = {}) {
  return store.listDrafts(mediaSlug).find(({ draft }) => draft?.contentType === 'news'
    && draft?.qa?.passed
    && draft?.publicationEligibility?.status === 'eligible'
    && validTimestamp(draft.generatedAt) != null
    && validTimestamp(draft.generatedAt) >= now.getTime() - maximumAgeHours * 3_600_000
    && !store.hasEvent(`published:${mediaSlug}:news:${draft.slug}`)) || null;
}

export function newsDraftReceipt(draft, candidateId) {
  return videoDraftReceipt(draft, candidateId);
}

function markNewsRetry(store, eventKey, media, candidate, receipt) {
  store.markEvent(eventKey, receipt);
  const day = new Date().toISOString().slice(0, 10);
  const fingerprint = createHash('sha256')
    .update(`${media.slug}\n${candidate.id}\n${receipt.reason}`)
    .digest('hex')
    .slice(0, 10);
  const eventId = `candidate-deferred-${media.slug}-${day}-${fingerprint}`;
  if (!store.hasEvent(eventId)) {
    store.enqueue('events', eventId, {
      version: 1,
      eventId,
      type: 'editorial.engine.degraded',
      createdAt: new Date().toISOString(),
      mediaSlug: media.slug,
      candidateId: candidate.id,
      title: candidate.title,
      error: `Candidat différé: ${String(receipt.reason || 'preuve indisponible').slice(0, 500)}`,
      retryAt: receipt.nextRetryAt || null,
    });
    store.markEvent(eventId, { status: 'notified', reason: receipt.reason });
  }
}

export class MediaEngine {
  constructor({
    store = new MediaStateStore(),
    hermes = new HermesClient(),
    fetchImpl = fetch,
    offers = [],
    internalLinks = {},
    getChannelFeedImpl = getChannelFeed,
    getVideoInfoImpl = getVideoInfo,
    enrichCandidateEvidenceImpl = enrichCandidateEvidence,
    env = process.env,
  } = {}) {
    this.store = store;
    this.hermes = hermes;
    this.fetchImpl = fetchImpl;
    this.offers = offers;
    this.internalLinks = internalLinks;
    this.getChannelFeed = getChannelFeedImpl;
    this.getVideoInfo = getVideoInfoImpl;
    this.enrichCandidateEvidence = enrichCandidateEvidenceImpl;
    this.env = env;
  }

  validate() {
    assertValidRegistry();
    return true;
  }

  selectedMedia(slug = null) {
    if (!slug) return activeMedia();
    const media = mediaBySlug(slug);
    if (!media) throw new Error(`Média inconnu: ${slug}`);
    if (!media.editorialEnabled) throw new Error(`Production éditoriale désactivée pour ${slug}`);
    return [media];
  }

  async collect({ mediaSlug = null, dryRun = false } = {}) {
    const selected = this.selectedMedia(mediaSlug);
    const sources = [...new Map(selected.flatMap((media) => sourcesForMedia(media.slug)).map((source) => [source.id, source])).values()];
    const previous = dryRun ? {} : this.store.read('source-health', { sources: {} }).sources || {};
    const results = await collectSources(sources, {
      previousBySource: previous,
      fetchImpl: this.fetchImpl,
    });
    if (!dryRun) {
      this.store.write('source-health', {
        version: 1,
        updatedAt: new Date().toISOString(),
        sources: Object.fromEntries(results.map((result) => [result.sourceId, result])),
      });
      for (const result of results) {
        for (const item of result.items) this.store.upsertObserved('candidates', `${result.sourceId}-${item.id}`, item);
      }
    }
    return results;
  }

  async researchX({ mediaSlug = null, dryRun = false, fromDate = '', toDate = '' } = {}) {
    const selected = this.selectedMedia(mediaSlug);
    const results = [];
    const policy = xSearchPolicy(this.env);
    const now = new Date();
    const latest = this.store.read('x-search-latest', { updatedAt: null });
    const budget = this.store.read('x-search-budget', { cooldownUntil: null });
    const cooldownUntil = Date.parse(budget.cooldownUntil || '');
    const lastSearchAt = Date.parse(latest.updatedAt || '');
    const deferredReason = !policy.enabled
      ? 'x-search-disabled'
      : (!Number.isNaN(cooldownUntil) && cooldownUntil > now.getTime())
        ? 'x-search-quota-cooldown'
        : (!Number.isNaN(lastSearchAt) && lastSearchAt + policy.intervalHours * 3_600_000 > now.getTime())
          ? 'x-search-interval-not-elapsed'
          : null;
    if (deferredReason && !dryRun) {
      this.store.write('x-search-policy', {
        version: 1,
        checkedAt: now.toISOString(),
        deferredReason,
        policy,
        cooldownUntil: budget.cooldownUntil || null,
        nextEligibleAt: !Number.isNaN(lastSearchAt)
          ? new Date(lastSearchAt + policy.intervalHours * 3_600_000).toISOString()
          : null,
      });
      return results;
    }
    const searches = selected.flatMap((media) => [
      ...(policy.officialOnly ? [] : (media.xQueries || []).map((query) => ({ media, query, officialSearch: false, allowedHandles: [] }))),
      ...(media.officialXQueries || []).map((search) => ({
        media,
        query: search.query,
        officialSearch: true,
        allowedHandles: search.allowedHandles || [],
      })),
    ]).slice(0, policy.maxQueries);
    const effectiveFromDate = fromDate || new Date(
      !Number.isNaN(lastSearchAt)
        ? lastSearchAt
        : now.getTime() - policy.intervalHours * 3_600_000,
    ).toISOString().slice(0, 10);
    const effectiveToDate = toDate || now.toISOString().slice(0, 10);
    if (dryRun) {
      return searches.map((search) => ({
        mediaSlug: search.media.slug,
        query: search.query,
        allowedHandles: search.allowedHandles,
        officialSearch: search.officialSearch,
        fromDate: effectiveFromDate,
        toDate: effectiveToDate,
        planned: true,
        degraded: null,
        citations: [],
      }));
    }
    let xaiAvailable = true;
    let unavailableReason = '';
    if (!dryRun) {
      try {
        const auth = await this.hermes.authList();
        xaiAvailable = auth.providers.includes('xai-oauth');
        if (!xaiAvailable) unavailableReason = 'xai-oauth absent';
      } catch (error) {
        xaiAvailable = false;
        unavailableReason = `auth Hermes inaccessible: ${String(error?.message || error)}`;
      }
    }
    for (const search of searches) {
      if (!xaiAvailable) {
        results.push({
          mediaSlug: search.media.slug,
          query: search.query,
          allowedHandles: search.allowedHandles,
          officialSearch: search.officialSearch,
          answer: '',
          citations: [],
          posts: [],
          degraded: true,
          degradedReason: unavailableReason,
          observedAt: new Date().toISOString(),
          sourceId: 'x-search',
        });
        continue;
      }
      let result;
      try {
        result = await this.hermes.xSearch({
          query: search.query,
          allowedHandles: search.allowedHandles,
          fromDate: effectiveFromDate,
          toDate: effectiveToDate,
          mediaSlug: search.media.slug,
        });
      } catch (error) {
        result = {
          query: search.query,
          answer: '',
          citations: [],
          posts: [],
          degraded: true,
          degradedReason: String(error?.message || error),
          observedAt: new Date().toISOString(),
          sourceId: 'x-search',
        };
      }
      const enriched = {
        ...result,
        mediaSlug: search.media.slug,
        officialSearch: search.officialSearch,
        allowedHandles: search.allowedHandles,
      };
      results.push(enriched);
      for (const item of xItems(enriched, search.media)) this.store.upsertObserved('candidates', item.id, item);
      if (quotaExceeded(enriched.degradedReason) || quotaExceeded(enriched.answer)) {
        const cooldown = new Date(now.getTime() + policy.quotaCooldownHours * 3_600_000).toISOString();
        this.store.write('x-search-budget', {
          version: 1,
          observedAt: new Date().toISOString(),
          reason: 'x-search-quota-exhausted',
          cooldownUntil: cooldown,
          policy,
        });
        break;
      }
    }
    this.store.write('x-search-latest', {
      version: 1,
      updatedAt: new Date().toISOString(),
      searchWindow: { fromDate: effectiveFromDate, toDate: effectiveToDate },
      results,
      policy,
    });
    return results;
  }

  qualify(items, { mediaSlug = null, persist = true } = {}) {
    const selected = this.selectedMedia(mediaSlug);
    const qualified = [];
    for (const media of selected) {
      const clusters = clusterCandidates(items.filter((item) => item.media?.includes(media.slug)));
      for (const cluster of clusters) {
        const candidate = qualifyCandidate(cluster, media, {
          offers: this.offers,
          minimumScore: MEDIA_ENGINE_DEFAULTS.minimumCandidateScore,
          maxAgeHours: MEDIA_ENGINE_DEFAULTS.candidateMaxAgeHours,
        });
        qualified.push(candidate);
        if (persist) {
          this.store.upsertObserved(candidate.status === 'qualified' ? 'qualified' : 'candidates', `${media.slug}-${candidate.id}`, candidate);
        }
      }
    }
    return qualified.sort((a, b) => b.score - a.score);
  }

  async generateDraft(candidate, {
    contentType = 'news',
    video = null,
    dryRun = false,
    generateBanner = true,
    publicationEligibility = null,
  } = {}) {
    const media = mediaBySlug(candidate.mediaSlug);
    if (!media?.editorialEnabled) throw new Error(`Média non actif: ${candidate.mediaSlug}`);
    if (candidate.status !== 'qualified') throw new Error(`Candidat non qualifié: ${candidate.id}`);
    const draftConflict = findDraftConflict(
      candidate,
      this.store.listDrafts(media.slug).map((entry) => ({ ...entry.draft, draftPath: entry.path })),
      { mediaSlug: media.slug, contentType },
    );
    if (draftConflict) {
      return {
        status: 'blocked',
        reason: `duplicate-draft:${draftConflict.reason}`,
        duplicateDraftPath: draftConflict.draft.draftPath || null,
      };
    }
    const publishedConflict = findInternalLinkConflict(candidate, this.internalLinks[media.slug] || []);
    if (publishedConflict) {
      return {
        status: 'blocked',
        reason: 'already-published-or-similar',
        publishedPath: publishedConflict.path,
      };
    }
    const prompt = buildEditorialPrompt({
      media,
      candidate,
      contentType,
      video,
      internalLinks: this.internalLinks[media.slug] || [],
      offer: candidate.offer,
    });
    if (dryRun) return { planned: true, mediaSlug: media.slug, candidateId: candidate.id, contentType, prompt };

    const payload = await this.hermes.generateEditorialJson(prompt, { contentType });
    let draft = normalizeDraft(payload, { contentType, candidate, media });
    if (draft.status === 'blocked') return draft;
    if (contentType === 'video') draft.video = video;

    const initialQa = qaDraft(draft, media, { candidate, requireBanner: false });
    let textQa = initialQa;
    let repairAttempts = 0;
    let repairError = null;
    const repairLimit = qaRepairLimit(this.env);
    while (!textQa.passed && repairAttempts < repairLimit && qaCanBeRepaired(textQa)) {
      repairAttempts += 1;
      try {
        const repairPayload = await this.hermes.generateEditorialJson(buildEditorialRepairPrompt({
          media,
          candidate,
          contentType,
          draft,
          qa: textQa,
        }), { contentType });
        const repairedDraft = normalizeDraft(repairPayload, { contentType, candidate, media });
        if (repairedDraft.status === 'blocked') {
          repairError = repairedDraft.reason || 'repair-blocked';
          break;
        }
        draft = repairedDraft;
        if (contentType === 'video') draft.video = video;
        textQa = qaDraft(draft, media, { candidate, requireBanner: false });
      } catch (error) {
        repairError = String(error?.message || error);
        break;
      }
    }
    draft.qaRepair = {
      attempted: repairAttempts > 0,
      attempts: repairAttempts,
      limit: repairLimit,
      resolved: textQa.passed,
      initialIssueCodes: initialQa.issues.filter((entry) => entry.severity === 'error').map((entry) => entry.code),
      remainingIssueCodes: textQa.issues.filter((entry) => entry.severity === 'error').map((entry) => entry.code),
      error: repairError,
    };

    if (generateBanner && contentType !== 'video') {
      const bannerResult = await this.hermes.generateBannerJson(buildBannerPrompt({ media, draft }));
      const imageSource = bannerResult?.imageSource || bannerResult?.imageUrl || bannerResult?.image;
      if (!bannerResult?.success || !imageSource) throw new Error(`Génération de bannière échouée pour ${draft.slug}`);
      const bannerPath = join(this.store.assetsDir, media.slug, `${draft.slug}.webp`);
      await materializeBanner(imageSource, bannerPath, this.fetchImpl);
      draft.banner = {
        path: bannerPath,
        alt: bannerResult.alt || draft.bannerBrief?.alt || draft.title,
        width: 1_200,
        height: 630,
        source: `hermes:image_gen:${ARTICLE_THUMBNAIL_POLICY}`,
      };
    } else if (contentType === 'video' && video?.thumbnailPath) {
      draft.banner = {
        path: video.thumbnailPath,
        alt: video.thumbnailAlt || draft.title,
        width: video.thumbnailWidth || 1_280,
        height: video.thumbnailHeight || 720,
        source: 'youtube-thumbnail',
        policy: 'associated-video-thumbnail',
      };
    }

    const qa = qaDraft(draft, media, { candidate, requireBanner: true });
    draft = {
      ...draft,
      qa,
      publicationEligibility: {
        status: qa.passed ? publicationEligibility?.status || 'eligible' : 'blocked',
        checkedAt: new Date().toISOString(),
        reason: qa.passed ? publicationEligibility?.reason || null : 'qa-failed',
      },
    };
    const draftPath = this.store.saveDraft(media.slug, draft);
    const editorialEvent = {
      version: 1,
      editorialRevision: EDITORIAL_REVISION,
      type: qa.passed ? 'editorial.draft.qa-passed' : 'editorial.draft.qa-failed',
      createdAt: new Date().toISOString(),
      mediaSlug: media.slug,
      candidateId: candidate.id,
      contentType,
      draftPath,
      title: draft.title,
      bannerPath: draft.banner?.path || null,
      scheduledPublishAt: draft.scheduledPublishAt || null,
      qa,
    };
    this.store.enqueue('events', `${media.slug}-${candidate.id}-${contentType}`, editorialEvent);
    this.store.markEvent(`draft:${media.slug}:${candidate.id}:${contentType}`, {
      status: qa.passed ? 'qa-passed' : 'qa-failed',
      editorialRevision: EDITORIAL_REVISION,
      slug: draft.slug,
      draftPath,
    });
    return { ...draft, draftPath };
  }

  async runVideoCycle({ mediaSlug = null, dryRun = false } = {}) {
    const results = [];
    for (const media of this.selectedMedia(mediaSlug)) {
      let unseen = null;
      try {
        const feed = await this.getChannelFeed(media.channelId);
        const mediaLinks = this.internalLinks[media.slug] || [];
        const eventPrefix = `video-draft:${media.slug}:`;
        const persistedBacklog = Object.entries(this.store.read('events', { events: {} }).events || {})
          .filter(([key]) => key.startsWith(eventPrefix) && shouldGenerateDraftForEvent(this.store, key))
          .map(([key, event]) => ({
            videoId: key.slice(eventPrefix.length),
            title: event?.title || null,
            link: `https://www.youtube.com/watch?v=${key.slice(eventPrefix.length)}`,
            retrySource: 'persisted-backlog',
            eventAt: event?.at || null,
          }))
          .filter((entry) => entry.videoId)
          .sort((left, right) => (Date.parse(left.eventAt) || 0) - (Date.parse(right.eventAt) || 0));
        const alreadyPublished = feed.filter((entry) => publishedVideoPath(mediaLinks, entry.videoId));
        const backlogAlreadyPublished = persistedBacklog.filter((entry) => publishedVideoPath(mediaLinks, entry.videoId));
        if (!dryRun) {
          for (const entry of [...alreadyPublished, ...backlogAlreadyPublished]) {
            this.store.markEvent(`video-draft:${media.slug}:${entry.videoId}`, {
              status: 'already-published',
              path: publishedVideoPath(mediaLinks, entry.videoId),
            });
          }
        }
        const publishedIds = new Set([...alreadyPublished, ...backlogAlreadyPublished].map((entry) => entry.videoId));
        const pending = feed.filter((entry) => !publishedIds.has(entry.videoId)
          && shouldGenerateDraftForEvent(this.store, `video-draft:${media.slug}:${entry.videoId}`));
        const shortsFromFeed = pending.filter((entry) => String(entry.link || '').includes('/shorts/'));
        if (!dryRun) {
          for (const short of shortsFromFeed) {
            this.store.markEvent(`video-draft:${media.slug}:${short.videoId}`, { status: 'ignored-short-or-live', source: 'youtube-rss' });
          }
        }
        const retryBacklog = persistedBacklog.filter((entry) => !publishedIds.has(entry.videoId));
        const candidateIds = new Set();
        const candidates = [...retryBacklog, ...pending].filter((entry) => {
          if (candidateIds.has(entry.videoId)) return false;
          candidateIds.add(entry.videoId);
          return true;
        });
        unseen = candidates.find((entry) => !String(entry.link || '').includes('/shorts/')) || null;
        if (!unseen) {
          results.push({ mediaSlug: media.slug, skipped: true, reason: 'no-unseen-long-video', ignoredShorts: shortsFromFeed.length });
          continue;
        }
        const lookbackDays = positiveInteger(this.env.MEDIA_ENGINE_VIDEO_LOOKBACK_DAYS, 7);
        const feedPublishedAt = plausibleVideoDate(unseen.pubDate);
        if (feedPublishedAt && feedPublishedAt.getTime() < Date.now() - lookbackDays * 86_400_000) {
          if (!dryRun) {
            this.store.markEvent(`video-draft:${media.slug}:${unseen.videoId}`, {
              status: 'historical-video-skipped',
              reason: `published-before-${lookbackDays}-day-lookback`,
              publishedAt: feedPublishedAt.toISOString(),
            });
          }
          results.push({
            mediaSlug: media.slug,
            videoId: unseen.videoId,
            skipped: true,
            reason: 'historical-video-outside-lookback',
            publishedAt: feedPublishedAt.toISOString(),
            dryRun,
          });
          continue;
        }
        if (dryRun) {
          results.push({ mediaSlug: media.slug, planned: true, video: unseen, ignoredShorts: shortsFromFeed.length });
          continue;
        }
        const eventKey = `video-draft:${media.slug}:${unseen.videoId}`;
        const info = await this.getVideoInfo(unseen.videoId);
        if (info.isShort || info.isLive) {
          this.store.markEvent(`video-draft:${media.slug}:${unseen.videoId}`, { status: 'ignored-short-or-live' });
          results.push({ mediaSlug: media.slug, skipped: true, reason: 'short-or-live', videoId: unseen.videoId });
          continue;
        }
        const previousEvent = this.store.getEvent(eventKey);
        const captionRequestPath = join(this.store.queueDir, 'caption-requests', `${unseen.videoId}.json`);
        const existingCaptionRequest = readJson(captionRequestPath, null);
        const captionRequestComplete = existingCaptionRequest?.status === 'complete';
        const awaitingOfficialCaption = previousEvent?.reason === 'transcript-incomplete-caption-requested'
          && !captionRequestComplete;
        const legacyTranscriptBlock = previousEvent?.status === 'editorial-blocked'
          && transcriptBlockNeedsCaption(previousEvent.reason)
          && !captionRequestComplete;
        if (awaitingOfficialCaption || legacyTranscriptBlock) {
          if (!existingCaptionRequest) {
            this.store.enqueue('caption-requests', unseen.videoId, {
              version: 1,
              videoId: unseen.videoId,
              mediaSlug: media.slug,
              channelId: media.channelId,
              title: info.title || unseen.title || null,
              languagePreferences: ['fr', 'en'],
              requestedAt: new Date().toISOString(),
              status: 'pending',
            });
          }
          this.store.markEvent(eventKey, {
            status: 'retryable-failure',
            reason: 'transcript-incomplete-caption-requested',
            nextRetryAt: retryAt(6),
          });
          results.push({
            mediaSlug: media.slug,
            videoId: unseen.videoId,
            retryScheduled: true,
            reason: 'transcript-incomplete-caption-requested',
          });
          continue;
        }
        if (!info.transcriptText || info.transcriptText.length < 500) {
          // Le moteur ne reçoit jamais de jeton Google. Il dépose seulement une
          // demande idempotente que le Studio, propriétaire des identifiants OAuth,
          // pourra traiter lorsqu'un profil aura explicitement reçu le scope captions.
          this.store.enqueue('caption-requests', unseen.videoId, {
            version: 1,
            videoId: unseen.videoId,
            mediaSlug: media.slug,
            channelId: media.channelId,
            title: info.title || unseen.title || null,
            languagePreferences: ['fr', 'en'],
            requestedAt: new Date().toISOString(),
            status: 'pending',
          });
          this.store.markEvent(`video-draft:${media.slug}:${unseen.videoId}`, {
            status: 'retryable-failure',
            reason: 'transcript-unavailable-caption-requested',
            nextRetryAt: retryAt(6),
          });
          results.push({ mediaSlug: media.slug, retryScheduled: true, reason: 'transcript-unavailable-caption-requested', videoId: unseen.videoId });
          continue;
        }
        const plausiblePublishedAt = plausibleVideoDate(info.publishedAt) || feedPublishedAt;
        if (plausiblePublishedAt && plausiblePublishedAt.getTime() < Date.now() - lookbackDays * 86_400_000) {
          this.store.markEvent(eventKey, {
            status: 'historical-video-skipped',
            reason: `published-before-${lookbackDays}-day-lookback`,
            publishedAt: plausiblePublishedAt.toISOString(),
          });
          results.push({
            mediaSlug: media.slug,
            videoId: unseen.videoId,
            skipped: true,
            reason: 'historical-video-outside-lookback',
            publishedAt: plausiblePublishedAt.toISOString(),
          });
          continue;
        }
        const thumbnailPath = join(this.store.assetsDir, media.slug, `${unseen.videoId}-youtube.jpg`);
        const thumbnail = await downloadFirstAvailableAsset(
          youtubeThumbnailCandidates(unseen.videoId, info.thumbnails),
          thumbnailPath,
          this.fetchImpl,
        );
        const matchedOffer = offerForUrl(this.offers, media.slug, info.affiliateUrl);
        const candidate = {
        id: `youtube-${unseen.videoId}`,
        title: info.title || unseen.title,
        primaryUrl: `https://www.youtube.com/watch?v=${unseen.videoId}`,
        publishedAt: plausiblePublishedAt?.toISOString() || null,
        media: [media.slug],
        mediaSlug: media.slug,
        score: 100,
        risk: media.risk,
        keywordMatches: [],
        officialSourceCount: 1,
        independentSourceCount: 1,
        corroborated: true,
        rumor: false,
        status: 'qualified',
        blockers: [],
        offer: matchedOffer ? {
          id: matchedOffer.id,
          name: matchedOffer.name,
          url: matchedOffer.url,
          disclosure: matchedOffer.disclosure || null,
        } : null,
        sources: [{
          sourceId: `youtube-${media.slug}`,
          tier: 0,
          official: true,
          title: info.title || unseen.title,
          url: `https://www.youtube.com/watch?v=${unseen.videoId}`,
          excerpt: info.description,
          publishedAt: info.publishedAt?.toISOString?.() || null,
          kind: 'youtube-video',
        }],
        };
        const video = {
        videoId: unseen.videoId,
        title: info.title || unseen.title,
        publishedAt: candidate.publishedAt,
        duration: info.duration,
        description: info.description,
        chapters: info.chapters,
        transcript: info.transcriptText,
        transcriptSource: info.transcriptSource,
        affiliateUrlObserved: info.affiliateUrl || null,
        affiliateOfferMatched: Boolean(matchedOffer),
        thumbnailPath,
        thumbnailAlt: `Miniature de la vidéo ${info.title || unseen.title}`,
        thumbnailWidth: thumbnail.width,
        thumbnailHeight: thumbnail.height,
        };
        const draft = await this.generateDraft(candidate, {
          contentType: 'video',
          video,
          generateBanner: false,
          publicationEligibility: plausiblePublishedAt ? null : {
            status: 'review-required',
            reason: 'video-published-at-unverified',
          },
        });
        let receipt = videoDraftReceipt(draft, candidate.id);
        if (receipt.status === 'editorial-blocked' && transcriptBlockNeedsCaption(receipt.reason)) {
          const request = readJson(captionRequestPath, null);
          if (request?.status !== 'complete') {
            if (!request) {
              this.store.enqueue('caption-requests', unseen.videoId, {
                version: 1,
                videoId: unseen.videoId,
                mediaSlug: media.slug,
                channelId: media.channelId,
                title: info.title || unseen.title || null,
                languagePreferences: ['fr', 'en'],
                requestedAt: new Date().toISOString(),
                status: 'pending',
              });
            }
            receipt = {
              status: 'retryable-failure',
              reason: 'transcript-incomplete-caption-requested',
              nextRetryAt: retryAt(6),
              editorialRevision: EDITORIAL_REVISION,
              candidateId: candidate.id,
            };
          }
        }
        this.store.markEvent(eventKey, receipt);
        results.push({
          mediaSlug: media.slug,
          videoId: unseen.videoId,
          draft,
          ...(receipt.status === 'retryable-failure' ? { retryScheduled: true, reason: receipt.reason } : {}),
        });
      } catch (error) {
        const message = String(error?.message || error);
        if (!dryRun && unseen?.videoId) {
          this.store.markEvent(`video-draft:${media.slug}:${unseen.videoId}`, {
            status: 'retryable-failure',
            reason: message,
            nextRetryAt: retryAt(2),
          });
        }
        results.push({ mediaSlug: media.slug, videoId: unseen?.videoId || null, retryScheduled: true, error: message });
      }
    }
    return results;
  }

  async runGuideCycle({ mediaSlug = null, opportunities = [], dryRun = false } = {}) {
    const selectedMedia = this.selectedMedia(mediaSlug);
    const lease = dryRun ? null : this.store.acquireLease('guide-cycle', { ttlMs: 4 * 60 * 60_000 });
    if (!dryRun && !lease) {
      return [{ mediaSlug: mediaSlug || null, skipped: true, reason: 'guide-lease-active' }];
    }
    const results = [];
    try {
      for (const media of selectedMedia) {
        const ranked = rankGuideOpportunities(opportunities, media.slug, this.offers);
        const eligible = ranked.filter((opportunity) => opportunity.eligible);
        if (!eligible.length) {
          results.push({
            mediaSlug: media.slug,
            skipped: true,
            blockers: ranked[0]?.blockers || ['aucune-opportunité-configurée'],
          });
          continue;
        }

        const processedOpportunityIds = [];
        const rejected = [];
        let selected = false;
        for (const opportunity of eligible) {
          const candidate = guideCandidate(opportunity, media);
          if (candidate.status !== 'qualified') {
            rejected.push({ opportunityId: opportunity.id, blockers: candidate.blockers });
            continue;
          }
          const eventKey = `guide-draft:${media.slug}:${opportunity.id}`;
          if (!shouldGenerateDraftForEvent(this.store, eventKey)) {
            processedOpportunityIds.push(opportunity.id);
            continue;
          }
          if (dryRun) {
            results.push({ mediaSlug: media.slug, planned: true, opportunity, candidate, processedOpportunityIds });
            selected = true;
            break;
          }
          const enrichedCandidate = await this.enrichCandidateEvidence(candidate, { fetchImpl: this.fetchImpl });
          const draft = await this.generateDraft(enrichedCandidate, { contentType: 'guide' });
          const receipt = videoDraftReceipt(draft, candidate.id);
          this.store.markEvent(eventKey, receipt);
          if (['duplicate-draft', 'already-published'].includes(receipt.status)) {
            processedOpportunityIds.push(opportunity.id);
            continue;
          }
          results.push({ mediaSlug: media.slug, opportunityId: opportunity.id, draft, processedOpportunityIds });
          selected = true;
          break;
        }
        if (!selected) results.push({
          mediaSlug: media.slug,
          skipped: true,
          reason: processedOpportunityIds.length ? 'all-eligible-opportunities-already-processed' : 'no-qualified-opportunity',
          processedOpportunityIds,
          blockers: rejected[0]?.blockers || [],
        });
      }
      return results;
    } finally {
      if (lease) this.store.releaseLease(lease);
    }
  }

  healthReport({ collectionResults = null, xResults = null } = {}) {
    const sourceState = this.store.read('source-health', { sources: {} });
    const sourceResults = collectionResults || Object.values(sourceState.sources || {});
    const requiredResults = sourceResults.filter((result) => result.required !== false);
    const sourcesHealthy = requiredResults.filter((result) => result.status === 'healthy').length;
    const sourcesDegraded = requiredResults.filter((result) => result.status !== 'healthy').length;
    const xValues = xResults || this.store.read('x-search-latest', { results: [] }).results || [];
    const lastRuns = this.store.read('last-runs', { runs: {} });
    const sourceAgeHours = sourceState.updatedAt && !Number.isNaN(Date.parse(sourceState.updatedAt))
      ? (Date.now() - Date.parse(sourceState.updatedAt)) / 3_600_000
      : null;
    const networkRun = lastRuns.runs?.run || null;
    const videoRun = lastRuns.runs?.video || null;
    const videoUnit = this.store.read('systemd-video', null);
    const eventState = this.store.read('events', { events: {} });
    const videoEvents = Object.entries(eventState.events || {})
      .filter(([key]) => key.startsWith('video-draft:'))
      .map(([, event]) => event || {});
    const now = Date.now();
    const retryableReady = videoEvents.filter((event) => event.status === 'retryable-failure'
      && (!event.nextRetryAt || Number.isNaN(Date.parse(event.nextRetryAt)) || Date.parse(event.nextRetryAt) <= now)).length;
    const retryableDeferred = videoEvents.filter((event) => event.status === 'retryable-failure'
      && event.nextRetryAt && !Number.isNaN(Date.parse(event.nextRetryAt)) && Date.parse(event.nextRetryAt) > now).length;
    const qaFailed = videoEvents.filter((event) => event.status === 'qa-failed').length;
    const editorialBlocked = videoEvents.filter((event) => event.status === 'editorial-blocked').length;
    const networkAgeHours = networkRun?.at && !Number.isNaN(Date.parse(networkRun.at))
      ? (Date.now() - Date.parse(networkRun.at)) / 3_600_000
      : null;
    const videoAgeHours = videoRun?.at && !Number.isNaN(Date.parse(videoRun.at))
      ? (Date.now() - Date.parse(videoRun.at)) / 3_600_000
      : null;
    let status = 'healthy';
    const blockers = [];
    const warnings = [];
    if (!requiredResults.length) blockers.push('source-health-unobserved');
    if (sourcesDegraded > 0) blockers.push('required-sources-degraded');
    if (requiredResults.length && sourcesHealthy / requiredResults.length < 0.8) blockers.push('source-coverage-below-80-percent');
    if (sourceAgeHours != null && sourceAgeHours > 3) blockers.push('source-health-stale');
    if (networkRun?.status === 'failed') blockers.push('last-network-run-failed');
    if (networkRun?.status === 'degraded') blockers.push('last-network-run-degraded');
    if (networkRun?.status === 'warning') warnings.push('last-network-run-warning');
    if (networkAgeHours != null && networkAgeHours > 3) blockers.push('network-run-stale');
    if (videoRun?.status === 'failed') blockers.push('last-video-run-failed');
    if (videoRun?.status === 'degraded') blockers.push('last-video-run-degraded');
    if (videoRun?.status === 'warning') warnings.push('last-video-run-warning');
    if (videoAgeHours != null && videoAgeHours > 3) blockers.push('video-run-stale');
    if (videoUnit && videoUnit.result !== 'success') blockers.push(`video-service-${videoUnit.result || 'failed'}`);
    if (retryableReady > 0) blockers.push('video-retryable-failures-ready');
    if (qaFailed > 0) blockers.push('video-qa-failures');
    if (editorialBlocked > 0) blockers.push('video-editorial-blocked');
    if (retryableDeferred > 0) warnings.push('video-retries-scheduled');
    if (xValues.length && xValues.every((result) => result.degraded)) warnings.push('x-search-unavailable');
    if (blockers.length) status = blockers.some((value) => /failed|below/.test(value)) ? 'critical' : 'degraded';
    else if (warnings.length) status = 'degraded';
    return {
      version: 1,
      observedAt: new Date().toISOString(),
      status,
      blockers,
      warnings,
      sources: {
        total: requiredResults.length,
        healthy: sourcesHealthy,
        degraded: sourcesDegraded,
        coverage: requiredResults.length ? sourcesHealthy / requiredResults.length : null,
        optionalDegraded: sourceResults.filter((result) => result.required === false && result.status !== 'healthy').length,
      },
      xSearch: {
        total: xValues.length,
        cited: xValues.filter((result) => result.citations?.length && !result.degraded).length,
        degraded: xValues.filter((result) => result.degraded).length,
      },
      videoBacklog: {
        retryableReady,
        retryableDeferred,
        qaFailed,
        editorialBlocked,
      },
      publicationMode: this.env.MEDIA_ENGINE_PUBLICATION_MODE || 'draft',
      freshness: {
        sourceHealthAgeHours: sourceAgeHours,
        networkRunAgeHours: networkAgeHours,
        videoRunAgeHours: videoAgeHours,
      },
      lastRuns: lastRuns.runs || {},
    };
  }

  monitor({ dryRun = false } = {}) {
    const health = this.healthReport();
    if (dryRun || health.status === 'healthy') return { health, event: null };
    this.store.initialize();
    const day = new Date().toISOString().slice(0, 10);
    const fingerprint = createHash('sha256')
      .update([...health.blockers, ...(health.warnings || [])].sort().join('\n'))
      .digest('hex')
      .slice(0, 10);
    const eventId = `engine-${health.status}-${day}-${fingerprint}`;
    const event = {
      version: 1,
      eventId,
      type: 'editorial.engine.degraded',
      createdAt: new Date().toISOString(),
      mediaSlug: 'chaimbault',
      health,
      error: [...health.blockers, ...(health.warnings || [])].join(', '),
    };
    if (!this.store.hasEvent(eventId)) {
      this.store.enqueue('events', eventId, event);
      this.store.markEvent(eventId, { status: health.status });
    }
    return { health, event };
  }

  async runCycle({ mediaSlug = null, dryRun = false, generateDrafts = true } = {}) {
    this.validate();
    if (dryRun) {
      const collection = await this.collect({ mediaSlug, dryRun: true });
      const xSearch = await this.researchX({ mediaSlug, dryRun: true });
      const candidates = this.qualify(collection.flatMap((result) => result.items), { mediaSlug, persist: false });
      return {
        dryRun: true,
        collection,
        xSearch,
        candidates,
        plannedDrafts: candidates.filter((candidate) => candidate.status === 'qualified').slice(0, this.selectedMedia(mediaSlug).length),
        health: this.healthReport({ collectionResults: collection, xResults: xSearch }),
      };
    }
    this.store.initialize();
    const lease = this.store.acquireLease('network-cycle');
    if (!lease) return { skipped: true, reason: 'lease-active' };
    try {
      const collection = await this.collect({ mediaSlug });
      const xSearch = await this.researchX({ mediaSlug });
      const items = [
        ...collection.flatMap((result) => result.items),
        ...xSearch.flatMap((result) => {
          const media = mediaBySlug(result.mediaSlug);
          return media ? xItems(result, media) : [];
        }),
      ];
      const candidates = this.qualify(items, { mediaSlug });
      const selected = this.selectedMedia(mediaSlug);
      const candidatePool = buildQualifiedCandidatePool({
        currentCandidates: candidates,
        // Les flux inchangés répondent souvent 304 et ne réémettent aucun
        // item pendant le cycle. Relire aussi la file des candidats jadis
        // rejetés permet de les requalifier après une correction de taxonomie
        // ou de scoring, sans attendre une modification artificielle du flux.
        queueEntries: [
          ...this.store.listQueueEntries('qualified'),
          ...this.store.listQueueEntries('candidates'),
        ],
        media: selected,
        offers: this.offers,
      });
      const drafts = [];
      const attempts = [];
      if (generateDrafts) {
        for (const media of selected) {
          const pendingDraft = pendingEligibleNewsDraft(this.store, media.slug);
          if (pendingDraft) {
            attempts.push({
              mediaSlug: media.slug,
              status: 'waiting-publication',
              candidateId: pendingDraft.draft.candidateId,
              draftPath: pendingDraft.path,
            });
            continue;
          }
          const mediaCandidates = candidatePool.filter((candidate) => candidate.mediaSlug === media.slug);
          let inspected = 0;
          let evidenceAttempts = 0;
          let generationAttempts = 0;
          for (const candidate of mediaCandidates) {
            if (inspected >= 20 || evidenceAttempts >= 3 || generationAttempts >= 2) break;
            const eventKey = `draft:${media.slug}:${candidate.id}:news`;
            if (!shouldGenerateDraftForEvent(this.store, eventKey)) {
              attempts.push({ mediaSlug: media.slug, candidateId: candidate.id, status: 'already-processed' });
              continue;
            }
            // Le plafond borne les nouveaux candidats réellement examinés.
            // Les entrées déjà traitées ne doivent pas affamer la file fraîche.
            inspected += 1;

            const draftConflict = findDraftConflict(
              candidate,
              this.store.listDrafts(media.slug).map((entry) => ({ ...entry.draft, draftPath: entry.path })),
              { mediaSlug: media.slug, contentType: 'news' },
            );
            if (draftConflict) {
              const receipt = newsDraftReceipt({
                status: 'blocked',
                reason: `duplicate-draft:${draftConflict.reason}`,
                duplicateDraftPath: draftConflict.draft.draftPath || null,
              }, candidate.id);
              this.store.markEvent(eventKey, receipt);
              attempts.push({ mediaSlug: media.slug, candidateId: candidate.id, ...receipt });
              continue;
            }
            const publishedConflict = findInternalLinkConflict(candidate, this.internalLinks[media.slug] || []);
            if (publishedConflict) {
              const receipt = newsDraftReceipt({
                status: 'blocked',
                reason: 'already-published-or-similar',
                publishedPath: publishedConflict.path,
              }, candidate.id);
              this.store.markEvent(eventKey, receipt);
              attempts.push({ mediaSlug: media.slug, candidateId: candidate.id, ...receipt });
              continue;
            }

            evidenceAttempts += 1;
            try {
              const normalizedCandidate = normalizeEnrichedXEvidence(
                await this.enrichCandidateEvidence(candidate, { fetchImpl: this.fetchImpl }),
                media,
                candidate,
              );
              // L'enrichissement peut révéler un rappel, un accident ou un
              // défaut absent du titre initial. Le gate officiel est donc
              // recalculé sur la preuve enrichie et ne peut jamais rester figé
              // sur une valeur pré-enrichissement plus permissive.
              const officialRequired = candidateRequiresOfficialEvidence(normalizedCandidate, media);
              const enrichedCandidate = { ...normalizedCandidate, officialRequired };
              const availableSources = (enrichedCandidate.sources || [])
                .filter((source) => source.evidenceStatus === 'available');
              const officialEvidenceAvailable = availableSources.some((source) => source.official && Number(source.tier) <= 1);
              const accessibleDomains = new Set(availableSources.map((source) => {
                try { return new URL(source.url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return source.sourceId; }
              }).filter(Boolean));
              const evidenceCorroborated = officialEvidenceAvailable || accessibleDomains.size >= 2;
              if (!enrichedCandidate.evidenceAvailableCount
                || (officialRequired && !officialEvidenceAvailable)
                || (!officialRequired && !evidenceCorroborated)) {
                const reason = officialRequired && !officialEvidenceAvailable
                  ? 'source-officielle-inaccessible'
                  : !evidenceCorroborated
                    ? 'corroboration-accessible-insuffisante'
                    : 'preuve-source-inaccessible';
                const receipt = {
                  status: 'retryable-failure',
                  reason,
                  nextRetryAt: retryAt(2),
                  evidenceRevision: EVIDENCE_REVISION,
                  editorialRevision: EDITORIAL_REVISION,
                  candidateId: candidate.id,
                };
                markNewsRetry(this.store, eventKey, media, candidate, receipt);
                attempts.push({ mediaSlug: media.slug, candidateId: candidate.id, ...receipt });
                continue;
              }

              generationAttempts += 1;
              const draft = await this.generateDraft(enrichedCandidate, { contentType: 'news' });
              const receipt = newsDraftReceipt(draft, candidate.id);
              const { at: _previousAt, ...previousReceipt } = this.store.getEvent(eventKey) || {};
              this.store.markEvent(eventKey, { ...previousReceipt, ...receipt });
              attempts.push({ mediaSlug: media.slug, candidateId: candidate.id, ...receipt });
              if (draft?.qa?.passed) {
                drafts.push(draft);
                break;
              }
            } catch (error) {
              const message = String(error?.message || error);
              const receipt = {
                status: 'retryable-failure',
                reason: message,
                nextRetryAt: retryAt(2),
                editorialRevision: EDITORIAL_REVISION,
                candidateId: candidate.id,
              };
              markNewsRetry(this.store, eventKey, media, candidate, receipt);
              attempts.push({ mediaSlug: media.slug, candidateId: candidate.id, ...receipt });
              continue;
            }
          }
          if (!mediaCandidates.length) attempts.push({ mediaSlug: media.slug, status: 'no-fresh-qualified-candidate' });
        }
      }
      return {
        dryRun: false,
        collection,
        xSearch,
        candidates,
        candidatePool,
        attempts,
        drafts,
        health: this.healthReport({ collectionResults: collection, xResults: xSearch }),
      };
    } finally {
      this.store.releaseLease(lease);
    }
  }
}

export { bannerBuffer, downloadAsset, materializeBanner };
