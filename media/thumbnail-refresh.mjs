const REFRESHABLE_CONTENT_TYPES = new Set(['news', 'guide']);

export function refreshableThumbnailDrafts(entries) {
  return (entries || [])
    .filter((entry) => entry?.draft && REFRESHABLE_CONTENT_TYPES.has(entry.draft.contentType))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function thumbnailRefreshSelection(entries) {
  return refreshableThumbnailDrafts(entries);
}

// Compatibilité d'import: la sélection n'est plus tronquée par une taille de
// lot arbitraire. La consommation est bornée au niveau des tentatives par le
// budget global et le coupe-circuit de génération.
export function representativeThumbnailBatch(entries) {
  return thumbnailRefreshSelection(entries);
}
