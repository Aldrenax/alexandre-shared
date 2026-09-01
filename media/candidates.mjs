import { createHash } from 'node:crypto';

const STOP_WORDS = new Set([
  'avec', 'dans', 'des', 'elle', 'elles', 'est', 'les', 'leur', 'leurs', 'mais',
  'par', 'pas', 'pour', 'que', 'qui', 'ses', 'son', 'sur', 'une', 'vous', 'the',
  'and', 'for', 'from', 'this', 'that', 'what', 'when', 'why',
]);

const PERSISTED_EVENT_GENERIC_TOKENS = new Set([
  'annonce', 'announced', 'announces', 'announcing',
  'lance', 'lancement', 'launch', 'launched', 'launches', 'launching',
  'publie', 'publication', 'publish', 'published', 'publishes',
  'arrive', 'arrives', 'available', 'disponible',
  'nouveau', 'nouvelle', 'nouveaux', 'nouvelles',
  'official', 'officiel', 'officielle', 'update', 'updates',
  'issue', 'issues', 'probleme', 'problemes', 'report', 'reports',
  'recall', 'recalls', 'rappel', 'rappels',
]);

export const DEFAULT_MAX_CANDIDATE_AGE_HOURS = 72;

const PRODUCT_SAFETY_KEYWORDS = Object.freeze([
  'sécurité', 'safety',
  'rappel', 'rappels', 'recall', 'recalls',
  'accident', 'accidents',
  'crash', 'crashes', 'collision', 'collisions',
  'incendie', 'incendies', 'fire', 'fires',
  'décès', 'death', 'fatal', 'fatality', 'blessure', 'blessures', 'injury', 'injuries',
  'défaut', 'défauts', 'défaillance', 'défaillances', 'defect', 'defects', 'failure', 'failures',
  'frein', 'freins', 'brake', 'brakes', 'airbag', 'airbags',
  'enquête', 'investigation', 'probe', 'NHTSA',
]);

function normalizeText(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value) {
  return new Set(normalizeText(value).split(' ').filter((word) => word.length >= 3 && !STOP_WORDS.has(word)));
}

/**
 * Recherche un mot-clé ou une phrase complète dans un texte normalisé. Les
 * espaces ajoutés imposent des bornes de tokens : `IA` ne correspond donc ni
 * à `India` ni à `reliability`, et `PEA` ne correspond pas à `European`.
 */
export function textMatchesKeyword(value, keyword) {
  const haystack = normalizeText(value);
  const needle = normalizeText(keyword);
  if (!haystack || !needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

export function similarity(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function persistedEventTokens(value, media) {
  const topicTokens = tokens((media?.topicKeywords || []).join(' '));
  return new Set([...tokens(value)].filter((word) => word.length >= 5
    && !topicTokens.has(word)
    && !PERSISTED_EVENT_GENERIC_TOKENS.has(word)));
}

function numericClaims(value) {
  const claims = String(value || '').toLowerCase().match(/\b\d+(?:[.,]\d+)*(?:x|%|€|\$)?\b/g) || [];
  return new Set(claims.map((claim) => claim.replace(',', '.')));
}

/**
 * Un rapprochement historique doit être plus strict que le clustering d'un
 * flux instantané. La similarité seule peut confondre deux annonces d'une
 * même marque. On exige donc une fenêtre temporelle courte, deux termes
 * descriptifs communs hors taxonomie du média et aucune valeur numérique
 * contradictoire. Les groupes sont ensuite construits en complete-link.
 */
export function samePersistedNewsEvent(left, right, media, {
  threshold = 0.58,
  maximumGapHours = 48,
  minimumSharedDiscriminants = 2,
} = {}) {
  if (left?.kind === 'official-api' && right?.kind === 'official-api'
    && left?.sourceId === right?.sourceId
    && left?.id != null && right?.id != null
    && String(left.id) !== String(right.id)) return false;
  if (canonicalUrl(left?.url) === canonicalUrl(right?.url)) return true;
  const leftTime = Date.parse(left?.publishedAt || '');
  const rightTime = Date.parse(right?.publishedAt || '');
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return false;
  if (Math.abs(leftTime - rightTime) > maximumGapHours * 3_600_000) return false;
  if (similarity(left?.title, right?.title) < threshold) return false;

  const leftNumbers = numericClaims(left?.title);
  const rightNumbers = numericClaims(right?.title);
  if (leftNumbers.size && rightNumbers.size
    && (leftNumbers.size !== rightNumbers.size
      || [...leftNumbers].some((value) => !rightNumbers.has(value)))) return false;

  if (normalizeText(left?.title) === normalizeText(right?.title)) return true;

  const leftTerms = persistedEventTokens(left?.title, media);
  const rightTerms = persistedEventTokens(right?.title, media);
  const shared = [...leftTerms].filter((value) => rightTerms.has(value));
  return shared.length >= minimumSharedDiscriminants;
}

function urlsFor(value = {}) {
  return new Set([
    value.primaryUrl,
    ...(value.sourceUrls || []),
    ...(value.sources || []).map((source) => source?.url),
  ].filter((url) => /^https?:\/\//.test(String(url || ''))).map(canonicalUrl));
}

function apiItemIdentitiesFor(value = {}) {
  return new Set([
    ...(value.sourceItemIds || []),
    ...(value.sources || [])
      .filter((source) => source?.kind === 'official-api' && source?.sourceId && source?.itemId != null)
      .map((source) => `${source.sourceId}:${source.itemId}`),
  ].filter(Boolean).map(String));
}

/**
 * Détecte un conflit éditorial à l'intérieur d'un même média. La même annonce
 * peut être traitée par deux sites si l'angle est différent ; elle ne doit pas
 * créer deux articles concurrents sur le même site.
 */
export function findDraftConflict(candidate, drafts = [], {
  mediaSlug,
  contentType = 'news',
  threshold = 0.58,
} = {}) {
  const candidateUrls = urlsFor(candidate);
  const candidateApiItems = apiItemIdentitiesFor(candidate);
  for (const draft of drafts) {
    if (draft?.mediaSlug !== mediaSlug || draft?.contentType !== contentType) continue;
    // A failed QA draft is an audit artifact, not editorial inventory. Keeping
    // it on disk must not prevent the next revised editorial revision.
    if (draft?.qa && !draft.qa.passed) continue;
    if (draft?.publicationEligibility?.status === 'quarantined') continue;
    const draftApiItems = apiItemIdentitiesFor(draft);
    const sharedApiItem = [...candidateApiItems].find((identity) => draftApiItems.has(identity));
    if (sharedApiItem) return { reason: 'same-source-item', sharedUrl: null, sharedApiItem, draft };
    // Deux enregistrements d'une API officielle sont deux événements distincts
    // même s'ils partagent le même endpoint et un libellé générique identique.
    if (candidateApiItems.size && draftApiItems.size) continue;
    const draftUrls = urlsFor(draft);
    const sharedUrl = [...candidateUrls].find((url) => draftUrls.has(url));
    if (sharedUrl) return { reason: 'same-source-url', sharedUrl, draft };
    if (similarity(candidate.title, draft.title) >= threshold) {
      return { reason: 'similar-title', sharedUrl: null, draft };
    }
  }
  return null;
}

export function findInternalLinkConflict(candidate, internalLinks = [], { threshold = 0.66 } = {}) {
  const candidateUrls = urlsFor(candidate);
  for (const entry of internalLinks) {
    const path = typeof entry === 'string' ? entry : entry?.path || entry?.url || '';
    const anchor = typeof entry === 'string' ? entry : entry?.anchor || entry?.title || path;
    if (candidateUrls.has(canonicalUrl(path)) || similarity(candidate.title, anchor) >= threshold) {
      return { path, anchor };
    }
  }
  return null;
}

export function canonicalUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_)/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return String(rawUrl || '').trim();
  }
}

function itemIdentity(item = {}) {
  if (item.kind === 'official-api' && item.sourceId && item.id != null) {
    return `${item.sourceId}:${item.id}`;
  }
  return canonicalUrl(item.url) || `${item.sourceId}:${item.id}`;
}

function clusterId(item) {
  return createHash('sha256').update(`${normalizeText(item.title)}\n${itemIdentity(item)}`).digest('hex').slice(0, 24);
}

export function dedupeItems(items = []) {
  const byKey = new Map();
  for (const item of items) {
    const key = itemIdentity(item);
    const current = byKey.get(key);
    if (!current || Number(item.sourceTier) < Number(current.sourceTier)) {
      byKey.set(key, { ...item, url: canonicalUrl(item.url) || item.url });
    }
  }
  return [...byKey.values()];
}

export function clusterCandidates(items = [], threshold = 0.46) {
  const clusters = [];
  const sorted = dedupeItems(items).sort((a, b) => {
    const tier = Number(a.sourceTier) - Number(b.sourceTier);
    if (tier) return tier;
    return String(b.publishedAt || '').localeCompare(String(a.publishedAt || ''));
  });

  for (const item of sorted) {
    let cluster = clusters.find((candidate) => {
      const distinctApiRecord = item.kind === 'official-api' && candidate.sources.some((source) => (
        source.kind === 'official-api'
        && source.sourceId === item.sourceId
        && source.itemId != null
        && String(source.itemId) !== String(item.id)
      ));
      return !distinctApiRecord && similarity(candidate.title, item.title) >= threshold;
    });
    if (!cluster) {
      cluster = {
        id: clusterId(item),
        title: item.title,
        primaryUrl: canonicalUrl(item.url),
        publishedAt: item.publishedAt || null,
        media: [...new Set(item.media || [])],
        sources: [],
      };
      clusters.push(cluster);
    }
    cluster.sources.push({
      sourceId: item.sourceId,
      tier: Number(item.sourceTier),
      official: Boolean(item.sourceOfficial),
      title: item.title,
      url: canonicalUrl(item.url),
      excerpt: item.excerpt || '',
      publishedAt: item.publishedAt || null,
      topicRoutes: Array.isArray(item.topicRoutes) ? [...new Set(item.topicRoutes)] : [],
      pageDateMode: item.pageDateMode || null,
      kind: item.kind || 'news',
      itemId: item.id != null ? String(item.id) : null,
    });
    cluster.media = [...new Set([...cluster.media, ...(item.media || [])])];
    if (Number(item.sourceTier) < Number(cluster.sources[0]?.tier ?? 5)) {
      cluster.title = item.title;
      cluster.primaryUrl = canonicalUrl(item.url);
      cluster.publishedAt = item.publishedAt || cluster.publishedAt;
    }
  }
  return clusters;
}

function ageHours(value, now) {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return Math.max(0, (now.getTime() - Date.parse(value)) / 3_600_000);
}

function candidateText(candidate = {}) {
  return [
    candidate.title,
    ...(candidate.sources || []).map((source) => `${source?.title || ''} ${source?.excerpt || ''}`),
  ].join(' ');
}

function keywordMatches(candidate, media) {
  const haystack = candidateText(candidate);
  return (media.topicKeywords || []).filter((keyword) => textMatchesKeyword(haystack, keyword));
}

function sourceRouteMatches(candidate, media) {
  return [...new Set((candidate.sources || [])
    .filter((source) => source.official && Number(source.tier) <= 1)
    .filter((source) => Array.isArray(source.topicRoutes) && source.topicRoutes.includes(media.slug))
    .map((source) => source.sourceId))];
}

export function candidateRequiresOfficialEvidence(candidate, media) {
  if (['regulated-finance', 'legal-tax'].includes(media?.risk)) return true;
  if (media?.risk !== 'product-safety') return false;
  const subject = candidateText(candidate);
  return PRODUCT_SAFETY_KEYWORDS.some((keyword) => textMatchesKeyword(subject, keyword));
}

export function eligibleOffers(offers = [], mediaSlug) {
  return offers.filter((offer) => {
    const channels = Array.isArray(offer.channels) ? offer.channels : [];
    return offer.status === 'active'
      && channels.includes(mediaSlug)
      && typeof offer.url === 'string'
      && /^https?:\/\//.test(offer.url);
  });
}

export function matchOffer(candidate, offers = [], mediaSlug) {
  const haystack = candidateText(candidate);
  return eligibleOffers(offers, mediaSlug)
    .map((offer) => {
      const keywords = Array.isArray(offer.keywords) ? offer.keywords : [];
      const matches = keywords.filter((keyword) => textMatchesKeyword(haystack, keyword));
      return { offer, score: matches.length };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.offer || null;
}

export function qualifyCandidate(candidate, media, {
  offers = [],
  now = new Date(),
  minimumScore = 70,
  maxAgeHours = DEFAULT_MAX_CANDIDATE_AGE_HOURS,
} = {}) {
  const sources = candidate.sources || [];
  const official = sources.filter((source) => source.official && source.tier <= 1);
  const independentDomains = new Set(sources.map((source) => {
    try { return new URL(source.url).hostname.replace(/^www\./, ''); } catch { return source.sourceId; }
  }));
  const matches = keywordMatches(candidate, media);
  const routedSources = sourceRouteMatches(candidate, media);
  const topical = matches.length > 0 || routedSources.length > 0;
  const age = ageHours(candidate.publishedAt, now);
  const maximumAge = Number.isFinite(Number(maxAgeHours)) && Number(maxAgeHours) >= 0
    ? Number(maxAgeHours)
    : DEFAULT_MAX_CANDIDATE_AGE_HOURS;
  const officialRequired = candidateRequiresOfficialEvidence(candidate, media);
  const rumor = sources.every((source) => source.tier >= 3 || /rumeur|rumor|leak|fuite/i.test(source.title));
  const hasEvidence = official.length > 0 || independentDomains.size >= 2;
  const corroborated = officialRequired ? official.length > 0 : hasEvidence;
  const offer = matchOffer(candidate, offers, media.slug);

  const authorityPoints = official.length ? 36 : sources.some((source) => source.tier === 2) ? 18 : 8;
  const corroborationPoints = independentDomains.size >= 2 ? 24 : official.length ? 14 : 8;
  const topicalityPoints = topical ? Math.min(20, 10 + ((Math.max(1, matches.length) - 1) * 5)) : 0;
  const freshnessPoints = age == null ? 10 : age <= 24 ? 18 : age <= maximumAge ? 10 : 2;
  const commercialFitPoints = offer ? 10 : 0;
  const rumorPenalty = rumor ? -30 : 0;
  const missingOfficialPenalty = officialRequired && !official.length ? -25 : 0;
  let score = 0;
  // Une annonce officielle et réellement thématique constitue déjà une preuve
  // exploitable. Les sources secondaires restent soumises à corroboration.
  score += authorityPoints;
  score += corroborationPoints;
  score += topicalityPoints;
  score += freshnessPoints;
  score += commercialFitPoints;
  score += rumorPenalty;
  score += missingOfficialPenalty;
  score = Math.max(0, Math.min(100, score));

  const blockers = [];
  if (!topical) blockers.push('hors-thématique');
  if (!hasEvidence) blockers.push('preuve-insuffisante');
  // Une source officielle n'est obligatoire que pour les verticales à risque
  // légal/fiscal/financier. Pour les autres, deux domaines indépendants sont
  // une issue valide : le diagnostic ne doit pas prétendre le contraire.
  if (officialRequired && !official.length) blockers.push('source-officielle-requise');
  if (rumor) blockers.push('rumeur-non-corroborée');
  if (age != null && age > maximumAge) blockers.push('candidat-trop-ancien');
  if (score < minimumScore) blockers.push(`score-inférieur-à-${minimumScore}`);

  return {
    ...candidate,
    mediaSlug: media.slug,
    score,
    risk: media.risk,
    ageHours: age,
    maxAgeHours: maximumAge,
    keywordMatches: matches,
    sourceRouteMatches: routedSources,
    topicMatched: topical,
    officialSourceCount: official.length,
    independentSourceCount: independentDomains.size,
    officialRequired,
    proofRequirement: officialRequired ? 'official' : 'official-or-two-independent-domains',
    corroborated,
    rumor,
    offer: offer ? {
      id: offer.id,
      name: offer.name,
      url: offer.url,
      disclosure: offer.disclosure || null,
    } : null,
    status: blockers.length ? 'rejected' : 'qualified',
    blockers,
    scoreBreakdown: {
      authority: authorityPoints,
      corroboration: corroborationPoints,
      topicality: topicalityPoints,
      freshness: freshnessPoints,
      commercialFit: commercialFitPoints,
      rumorPenalty,
      missingOfficialPenalty,
      total: score,
    },
    qualifiedAt: now.toISOString(),
  };
}
