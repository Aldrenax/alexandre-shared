import {
  MEDIA_ENGINE_DEFAULTS,
  MEDIA_NETWORK,
  MEDIA_SOURCES,
} from '../config/media-network.mjs';

const SOURCE_TYPES = new Set(['rss', 'api', 'page', 'x']);
const API_PROFILES = new Set(['sec-company-submissions']);
const PAGE_MODES = new Set(['document', 'links', 'reference']);
const PAGE_DATE_MODES = new Set(['published', 'modified']);
const RISK_LEVELS = new Set([
  'standard',
  'commercial',
  'product-safety',
  'regulated-finance',
  'legal-tax',
]);

export function validateRegistry({ media = MEDIA_NETWORK, sources = MEDIA_SOURCES } = {}) {
  const errors = [];
  const mediaSlugs = new Set();
  const channelIds = new Set();
  const topicNames = new Set();

  if (!Array.isArray(media) || media.length !== 8) {
    errors.push(`media: 8 entrées attendues, ${Array.isArray(media) ? media.length : 0} reçues`);
  }

  for (const item of media || []) {
    if (!item?.slug || mediaSlugs.has(item.slug)) errors.push(`media.slug invalide ou dupliqué: ${item?.slug}`);
    if (!item?.channelId || channelIds.has(item.channelId)) errors.push(`media.channelId invalide ou dupliqué: ${item?.channelId}`);
    if (!item?.topicName || topicNames.has(item.topicName)) errors.push(`media.topicName invalide ou dupliqué: ${item?.topicName}`);
    if (!RISK_LEVELS.has(item?.risk)) errors.push(`media.risk invalide pour ${item?.slug}: ${item?.risk}`);
    if (item?.editorialEnabled) {
      if (!item.siteUrl) errors.push(`media.siteUrl requis pour ${item.slug}`);
      if (!item.editorialBrief?.trim()) errors.push(`media.editorialBrief requis pour ${item.slug}`);
      if (!Array.isArray(item.sections) || !['actualites', 'videos', 'guides'].every((section) => item.sections.includes(section))) {
        errors.push(`media.sections incomplètes pour ${item.slug}`);
      }
      if (!item.cadence?.qualityOverridesQuota) errors.push(`media.cadence qualité prioritaire requise pour ${item.slug}`);
    }
    mediaSlugs.add(item?.slug);
    channelIds.add(item?.channelId);
    topicNames.add(item?.topicName);
  }

  const sourceIds = new Set();
  for (const source of sources || []) {
    if (!source?.id || sourceIds.has(source.id)) errors.push(`source.id invalide ou dupliqué: ${source?.id}`);
    if (!SOURCE_TYPES.has(source?.type)) errors.push(`source.type invalide pour ${source?.id}: ${source?.type}`);
    if (source?.apiProfile && source.type !== 'api') errors.push(`source.apiProfile réservé aux API pour ${source?.id}`);
    if (source?.apiProfile && !API_PROFILES.has(source.apiProfile)) errors.push(`source.apiProfile invalide pour ${source?.id}: ${source.apiProfile}`);
    if (source?.apiProfile === 'sec-company-submissions') {
      if (!/^\d+$/.test(String(source.apiCik || ''))) errors.push(`source.apiCik invalide pour ${source?.id}`);
      if (!Array.isArray(source.apiForms) || source.apiForms.length === 0) errors.push(`source.apiForms vide pour ${source?.id}`);
    }
    if (source?.quarantineAfterFailures != null
      && (!Number.isInteger(source.quarantineAfterFailures) || source.quarantineAfterFailures < 1)) {
      errors.push(`source.quarantineAfterFailures invalide pour ${source?.id}`);
    }
    if (source?.quarantineRetryHours != null
      && (!Number.isFinite(source.quarantineRetryHours) || source.quarantineRetryHours <= 0)) {
      errors.push(`source.quarantineRetryHours invalide pour ${source?.id}`);
    }
    if (source?.type === 'page' && source.pageMode && !PAGE_MODES.has(source.pageMode)) errors.push(`source.pageMode invalide pour ${source?.id}: ${source.pageMode}`);
    if (source?.type === 'page' && source.pageDateMode && !PAGE_DATE_MODES.has(source.pageDateMode)) errors.push(`source.pageDateMode invalide pour ${source?.id}: ${source.pageDateMode}`);
    if (!Number.isInteger(source?.tier) || source.tier < 0 || source.tier > 4) errors.push(`source.tier invalide pour ${source?.id}`);
    try {
      new URL(source?.url);
    } catch {
      errors.push(`source.url invalide pour ${source?.id}`);
    }
    if (!Array.isArray(source?.media) || source.media.length === 0) errors.push(`source.media vide pour ${source?.id}`);
    for (const slug of source?.media || []) {
      if (!mediaSlugs.has(slug)) errors.push(`source ${source.id}: média inconnu ${slug}`);
    }
    if (source?.official && source?.tier > 1) errors.push(`source officielle ${source?.id}: tier doit être 0 ou 1`);
    sourceIds.add(source?.id);
  }

  for (const item of media || []) {
    if (!item?.editorialEnabled) continue;
    const attached = (sources || []).filter((source) => source.media.includes(item.slug));
    if (!attached.some((source) => source.official)) errors.push(`aucune source officielle pour ${item.slug}`);
    if (!attached.some((source) => !source.official)) errors.push(`aucune source secondaire pour ${item.slug}`);
  }

  return errors;
}

export function assertValidRegistry(registry) {
  const errors = validateRegistry(registry);
  if (errors.length) throw new Error(`Registre média invalide:\n- ${errors.join('\n- ')}`);
  return true;
}

export function mediaBySlug(slug, media = MEDIA_NETWORK) {
  return media.find((item) => item.slug === slug) || null;
}

export function sourcesForMedia(slug, sources = MEDIA_SOURCES) {
  return sources.filter((source) => source.media.includes(slug));
}

export function activeMedia(media = MEDIA_NETWORK) {
  return media.filter((item) => item.editorialEnabled);
}

export function sourceById(id, sources = MEDIA_SOURCES) {
  return sources.find((source) => source.id === id) || null;
}

export function registrySnapshot() {
  assertValidRegistry();
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    defaults: MEDIA_ENGINE_DEFAULTS,
    media: MEDIA_NETWORK,
    sources: MEDIA_SOURCES,
  };
}

export { MEDIA_ENGINE_DEFAULTS, MEDIA_NETWORK, MEDIA_SOURCES };
