function activeOffer(offers, id, mediaSlug) {
  return offers.find((offer) => offer.id === id
    && offer.status === 'active'
    && offer.channels?.includes(mediaSlug)
    && /^https?:\/\//.test(offer.url || '')) || null;
}

function demandIsProven(evidence) {
  if (!evidence || typeof evidence !== 'object') return false;
  if (Number(evidence.gscImpressions) > 0) return true;
  if (Number(evidence.googleMonthlySearches) > 0) return true;
  if (Number(evidence.youtubeMonthlySearches) > 0) return true;
  return Array.isArray(evidence.urls) && evidence.urls.some((url) => /^https?:\/\//.test(url));
}

export function rankGuideOpportunities(opportunities = [], mediaSlug, offers = []) {
  return opportunities
    .filter((item) => item.mediaSlug === mediaSlug && item.status !== 'rejected')
    .map((item) => {
      const offer = activeOffer(offers, item.offerId, mediaSlug);
      const demand = demandIsProven(item.demandEvidence);
      const sources = Array.isArray(item.sources) ? item.sources.filter((source) => /^https?:\/\//.test(source?.url || '')) : [];
      const blockers = [];
      if (!offer) blockers.push('offre-active-introuvable');
      if (!demand) blockers.push('demande-non-prouvée');
      if (!sources.length) blockers.push('sources-absentes');
      return {
        ...item,
        offer,
        sources,
        blockers,
        eligible: blockers.length === 0,
        decisionScore: Number(item.priorityScore || 0)
          + Math.min(30, Number(item.demandEvidence?.gscImpressions || 0) / 100)
          + Math.min(20, Number(item.proprietaryClicks30d || 0)),
      };
    })
    .sort((a, b) => b.decisionScore - a.decisionScore);
}

export function selectGuideOpportunity(opportunities = [], mediaSlug, offers = []) {
  const evaluated = rankGuideOpportunities(opportunities, mediaSlug, offers);
  return evaluated.find((item) => item.eligible) || {
    mediaSlug,
    eligible: false,
    blockers: evaluated[0]?.blockers || ['aucune-opportunité-configurée'],
  };
}

export function guideCandidate(opportunity, media) {
  if (!opportunity?.eligible) throw new Error(`Opportunité guide non éligible: ${(opportunity?.blockers || []).join(', ')}`);
  const officialCount = opportunity.sources.filter((source) => source.official).length;
  const sensitive = ['regulated-finance', 'legal-tax', 'product-safety'].includes(media.risk);
  const blockers = [];
  if (sensitive && officialCount === 0) blockers.push('source-officielle-requise');
  return {
    id: `guide-${opportunity.id}`,
    title: opportunity.title,
    primaryUrl: opportunity.sources[0].url,
    publishedAt: null,
    media: [media.slug],
    mediaSlug: media.slug,
    score: Math.max(70, Math.min(100, opportunity.decisionScore || 70)),
    risk: media.risk,
    keywordMatches: opportunity.keywords || [],
    officialSourceCount: officialCount,
    independentSourceCount: new Set(opportunity.sources.map((source) => new URL(source.url).hostname)).size,
    corroborated: blockers.length === 0,
    rumor: false,
    status: blockers.length ? 'rejected' : 'qualified',
    blockers,
    offer: {
      id: opportunity.offer.id,
      name: opportunity.offer.name,
      url: opportunity.offer.url,
      disclosure: opportunity.offer.disclosure || null,
    },
    demandEvidence: opportunity.demandEvidence,
    sources: opportunity.sources.map((source, index) => ({
      sourceId: source.id || `guide-source-${index + 1}`,
      tier: Number.isInteger(source.tier) ? source.tier : source.official ? 1 : 2,
      official: Boolean(source.official),
      title: source.title || opportunity.title,
      url: source.url,
      excerpt: source.excerpt || '',
      publishedAt: source.publishedAt || null,
      kind: 'guide-research',
    })),
  };
}
