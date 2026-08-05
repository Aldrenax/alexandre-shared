import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getChannelFeed, getVideoInfo, youtubeThumbnailCandidates } from '../lib/youtube.mjs';
import { activeMedia, assertValidRegistry, mediaBySlug, sourcesForMedia } from './registry.mjs';
import { collectSources, enrichCandidateEvidence } from './source-collector.mjs';
import { clusterCandidates, qualifyCandidate } from './candidates.mjs';
import {
  buildBannerPrompt,
  buildEditorialPrompt,
  EDITORIAL_REVISION,
  normalizeDraft,
} from './editorial.mjs';
import { qaDraft } from './qa.mjs';
import { guideCandidate, selectGuideOpportunity } from './guide-planner.mjs';
import { HermesClient } from './hermes-client.mjs';
import { MediaStateStore } from './state-store.mjs';

function xItems(result, media) {
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
  return values.filter((post) => /^https?:\/\//.test(post.url || '')).map((post, index) => ({
    id: `x:${media.slug}:${index}:${post.url}`,
    sourceId: 'x-search',
    sourceTier: post.official || result.officialSearch ? 1 : 3,
    sourceOfficial: Boolean(post.official || result.officialSearch),
    title: post.summary || result.answer || result.query,
    url: post.url,
    excerpt: post.summary || result.answer || '',
    publishedAt: post.publishedAt || null,
    author: post.author || '',
    media: [media.slug],
    kind: 'x-search',
  }));
}

async function materializeBanner(imageUrl, destination, fetchImpl = fetch) {
  if (!/^https?:\/\//.test(imageUrl || '')) throw new Error('imageUrl Hermes invalide');
  const response = await fetchImpl(imageUrl, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Téléchargement bannière HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
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
    return !event.nextRetryAt || Number.isNaN(Date.parse(event.nextRetryAt)) || Date.parse(event.nextRetryAt) <= Date.now();
  }
  return event.status === 'qa-failed' && event.editorialRevision !== revision;
}

function retryAt(hours) {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
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
  } = {}) {
    this.store = store;
    this.hermes = hermes;
    this.fetchImpl = fetchImpl;
    this.offers = offers;
    this.internalLinks = internalLinks;
    this.getChannelFeed = getChannelFeedImpl;
    this.getVideoInfo = getVideoInfoImpl;
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
        for (const item of result.items) this.store.enqueue('candidates', `${result.sourceId}-${item.id}`, item);
      }
    }
    return results;
  }

  async researchX({ mediaSlug = null, dryRun = false, fromDate = '', toDate = '' } = {}) {
    const selected = this.selectedMedia(mediaSlug);
    const results = [];
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
    for (const media of selected) {
      for (const query of media.xQueries || []) {
        if (dryRun) {
          results.push({ mediaSlug: media.slug, query, planned: true, degraded: null, citations: [] });
          continue;
        }
        if (!xaiAvailable) {
          results.push({
            mediaSlug: media.slug,
            query,
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
          result = await this.hermes.xSearch({ query, fromDate, toDate, mediaSlug: media.slug });
        } catch (error) {
          result = {
            query,
            answer: '',
            citations: [],
            posts: [],
            degraded: true,
            degradedReason: String(error?.message || error),
            observedAt: new Date().toISOString(),
            sourceId: 'x-search',
          };
        }
        results.push({ ...result, mediaSlug: media.slug });
        for (const item of xItems(result, media)) this.store.enqueue('candidates', item.id, item);
      }
      for (const search of media.officialXQueries || []) {
        if (dryRun) {
          results.push({ mediaSlug: media.slug, query: search.query, allowedHandles: search.allowedHandles, officialSearch: true, planned: true, degraded: null, citations: [] });
          continue;
        }
        if (!xaiAvailable) {
          results.push({
            mediaSlug: media.slug,
            query: search.query,
            allowedHandles: search.allowedHandles,
            officialSearch: true,
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
            fromDate,
            toDate,
            mediaSlug: media.slug,
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
        const officialResult = { ...result, mediaSlug: media.slug, officialSearch: true };
        results.push(officialResult);
        for (const item of xItems(officialResult, media)) this.store.enqueue('candidates', item.id, item);
      }
    }
    if (!dryRun) this.store.write('x-search-latest', { version: 1, updatedAt: new Date().toISOString(), results });
    return results;
  }

  qualify(items, { mediaSlug = null, persist = true } = {}) {
    const selected = this.selectedMedia(mediaSlug);
    const qualified = [];
    for (const media of selected) {
      const clusters = clusterCandidates(items.filter((item) => item.media?.includes(media.slug)));
      for (const cluster of clusters) {
        const candidate = qualifyCandidate(cluster, media, { offers: this.offers });
        qualified.push(candidate);
        if (persist) {
          this.store.enqueue(candidate.status === 'qualified' ? 'qualified' : 'candidates', `${media.slug}-${candidate.id}`, candidate);
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
  } = {}) {
    const media = mediaBySlug(candidate.mediaSlug);
    if (!media?.editorialEnabled) throw new Error(`Média non actif: ${candidate.mediaSlug}`);
    if (candidate.status !== 'qualified') throw new Error(`Candidat non qualifié: ${candidate.id}`);
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

    if (generateBanner && contentType !== 'video') {
      const bannerResult = await this.hermes.generateBannerJson(buildBannerPrompt({ media, draft }));
      if (!bannerResult?.success || !bannerResult.imageUrl) throw new Error(`Génération de bannière échouée pour ${draft.slug}`);
      const bannerPath = join(this.store.assetsDir, media.slug, `${draft.slug}.webp`);
      await materializeBanner(bannerResult.imageUrl, bannerPath, this.fetchImpl);
      draft.banner = {
        path: bannerPath,
        alt: bannerResult.alt || draft.bannerBrief?.alt || draft.title,
        width: 1_200,
        height: 630,
        source: 'hermes:image_gen',
      };
    } else if (contentType === 'video' && video?.thumbnailPath) {
      draft.banner = {
        path: video.thumbnailPath,
        alt: video.thumbnailAlt || draft.title,
        width: video.thumbnailWidth || 1_280,
        height: video.thumbnailHeight || 720,
        source: 'youtube-thumbnail',
      };
    }

    const qa = qaDraft(draft, media, { candidate, requireBanner: true });
    draft = { ...draft, qa };
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
        const pending = feed.filter((entry) => shouldGenerateDraftForEvent(this.store, `video-draft:${media.slug}:${entry.videoId}`));
        const shortsFromFeed = pending.filter((entry) => String(entry.link || '').includes('/shorts/'));
        if (!dryRun) {
          for (const short of shortsFromFeed) {
            this.store.markEvent(`video-draft:${media.slug}:${short.videoId}`, { status: 'ignored-short-or-live', source: 'youtube-rss' });
          }
        }
        unseen = pending.find((entry) => !String(entry.link || '').includes('/shorts/')) || null;
        if (!unseen) {
          results.push({ mediaSlug: media.slug, skipped: true, reason: 'no-unseen-long-video', ignoredShorts: shortsFromFeed.length });
          continue;
        }
        if (dryRun) {
          results.push({ mediaSlug: media.slug, planned: true, video: unseen, ignoredShorts: shortsFromFeed.length });
          continue;
        }
        const info = await this.getVideoInfo(unseen.videoId);
        if (info.isShort || info.isLive) {
          this.store.markEvent(`video-draft:${media.slug}:${unseen.videoId}`, { status: 'ignored-short-or-live' });
          results.push({ mediaSlug: media.slug, skipped: true, reason: 'short-or-live', videoId: unseen.videoId });
          continue;
        }
        if (!info.transcriptText || info.transcriptText.length < 500) {
          this.store.markEvent(`video-draft:${media.slug}:${unseen.videoId}`, {
            status: 'retryable-failure',
            reason: 'transcript-unavailable',
            nextRetryAt: retryAt(6),
          });
          results.push({ mediaSlug: media.slug, failed: true, reason: 'transcript-unavailable', videoId: unseen.videoId });
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
        publishedAt: info.publishedAt?.toISOString?.() || unseen.pubDate?.toISOString?.() || null,
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
        const draft = await this.generateDraft(candidate, { contentType: 'video', video, generateBanner: false });
        this.store.markEvent(`video-draft:${media.slug}:${unseen.videoId}`, {
          status: draft.qa?.passed ? 'qa-passed' : draft.status === 'blocked' ? 'editorial-blocked' : 'qa-failed',
          editorialRevision: EDITORIAL_REVISION,
          candidateId: candidate.id,
        });
        results.push({ mediaSlug: media.slug, videoId: unseen.videoId, draft });
      } catch (error) {
        const message = String(error?.message || error);
        if (!dryRun && unseen?.videoId) {
          this.store.markEvent(`video-draft:${media.slug}:${unseen.videoId}`, {
            status: 'retryable-failure',
            reason: message,
            nextRetryAt: retryAt(2),
          });
        }
        results.push({ mediaSlug: media.slug, videoId: unseen?.videoId || null, failed: true, error: message });
      }
    }
    return results;
  }

  async runGuideCycle({ mediaSlug = null, opportunities = [], dryRun = false } = {}) {
    const results = [];
    for (const media of this.selectedMedia(mediaSlug)) {
      const opportunity = selectGuideOpportunity(opportunities, media.slug, this.offers);
      if (!opportunity.eligible) {
        results.push({ mediaSlug: media.slug, skipped: true, blockers: opportunity.blockers });
        continue;
      }
      const candidate = guideCandidate(opportunity, media);
      if (candidate.status !== 'qualified') {
        results.push({ mediaSlug: media.slug, skipped: true, blockers: candidate.blockers });
        continue;
      }
      if (dryRun) {
        results.push({ mediaSlug: media.slug, planned: true, opportunity, candidate });
        continue;
      }
      const eventKey = `guide-draft:${media.slug}:${opportunity.id}`;
      if (!shouldGenerateDraftForEvent(this.store, eventKey)) {
        results.push({ mediaSlug: media.slug, skipped: true, reason: 'already-drafted', opportunityId: opportunity.id });
        continue;
      }
      const enrichedCandidate = await enrichCandidateEvidence(candidate, { fetchImpl: this.fetchImpl });
      const draft = await this.generateDraft(enrichedCandidate, { contentType: 'guide' });
      this.store.markEvent(eventKey, {
        status: draft.qa?.passed ? 'qa-passed' : 'qa-failed',
        editorialRevision: EDITORIAL_REVISION,
        candidateId: candidate.id,
      });
      results.push({ mediaSlug: media.slug, opportunityId: opportunity.id, draft });
    }
    return results;
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
    if (networkAgeHours != null && networkAgeHours > 3) blockers.push('network-run-stale');
    if (videoRun?.status === 'failed') blockers.push('last-video-run-failed');
    if (videoRun?.status === 'degraded') blockers.push('last-video-run-degraded');
    if (videoAgeHours != null && videoAgeHours > 3) blockers.push('video-run-stale');
    if (videoUnit && videoUnit.result !== 'success') blockers.push(`video-service-${videoUnit.result || 'failed'}`);
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
      publicationMode: 'draft',
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
      const drafts = [];
      if (generateDrafts) {
        for (const media of this.selectedMedia(mediaSlug)) {
          const candidate = candidates.find((entry) => entry.mediaSlug === media.slug && entry.status === 'qualified');
          if (!candidate) continue;
          const eventKey = `draft:${media.slug}:${candidate.id}:news`;
          if (!shouldGenerateDraftForEvent(this.store, eventKey)) continue;
          const enrichedCandidate = await enrichCandidateEvidence(candidate, { fetchImpl: this.fetchImpl });
          if (!enrichedCandidate.evidenceAvailableCount) continue;
          drafts.push(await this.generateDraft(enrichedCandidate, { contentType: 'news' }));
        }
      }
      return {
        dryRun: false,
        collection,
        xSearch,
        candidates,
        drafts,
        health: this.healthReport({ collectionResults: collection, xResults: xSearch }),
      };
    } finally {
      this.store.releaseLease(lease);
    }
  }
}

export { downloadAsset, materializeBanner };
