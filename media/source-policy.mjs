import { sourcesForMedia } from './registry.mjs';

function configuredSourcesById(mediaSlug) {
  return new Map(sourcesForMedia(mediaSlug).map((source) => [source.id, source]));
}

/**
 * La configuration courante est l'autorite pour les politiques de source.
 * Une valeur persistee absente, obsolete ou mal orthographiee ne doit jamais
 * pouvoir desactiver un garde-fou ajoute apres la collecte initiale.
 */
export function hydrateConfiguredSourcePolicies(candidate, mediaSlug = candidate?.mediaSlug) {
  if (!candidate || !mediaSlug) return candidate || null;
  const configuredById = configuredSourcesById(mediaSlug);
  return {
    ...candidate,
    sources: (candidate.sources || []).map((source) => {
      const configured = configuredById.get(source?.sourceId);
      if (!configured) return source;
      return {
        ...source,
        sourcePolicy: configured.sourcePolicy || null,
      };
    }),
  };
}

export function sourcePolicySnapshot(candidate) {
  return (candidate?.sources || []).map((source, index) => ({
    ref: `S${index + 1}`,
    sourceId: source.sourceId || null,
    sourcePolicy: source.sourcePolicy || null,
    author: source.author || null,
    title: source.title || null,
    url: source.url || null,
  }));
}

/**
 * Reconstitue le contexte minimal necessaire a qaDraft lorsque la file
 * candidate historique n'existe plus. Les actualites historiques sans
 * snapshot restent volontairement bloquees : leur politique source est
 * impossible a prouver au moment de publier.
 */
export function candidateForDraft(draft, persistedCandidate = null) {
  if (persistedCandidate) {
    return hydrateConfiguredSourcePolicies(persistedCandidate, draft?.mediaSlug);
  }
  const snapshot = Array.isArray(draft?.sourcePolicySnapshot)
    ? draft.sourcePolicySnapshot
    : [];
  if (draft?.contentType === 'news' && snapshot.length === 0) return null;
  const sources = snapshot.length
    ? snapshot
    : (draft?.sourceUrls || []).map((url, index) => ({
      ref: `S${index + 1}`,
      sourceId: null,
      sourcePolicy: null,
      url,
    }));
  return hydrateConfiguredSourcePolicies({
    id: draft?.candidateId || null,
    mediaSlug: draft?.mediaSlug || null,
    status: 'qualified',
    corroborated: draft?.candidateQualification?.corroborated !== false,
    rumor: Boolean(draft?.candidateQualification?.rumor),
    sources,
  }, draft?.mediaSlug);
}
