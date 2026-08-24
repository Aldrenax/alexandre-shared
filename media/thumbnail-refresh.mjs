const REFRESHABLE_CONTENT_TYPES = new Set(['news', 'guide']);

export function refreshableThumbnailDrafts(entries) {
  return (entries || [])
    .filter((entry) => entry?.draft && REFRESHABLE_CONTENT_TYPES.has(entry.draft.contentType))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function representativeThumbnailBatch(entries, { limit = 6, all = false } = {}) {
  const eligible = refreshableThumbnailDrafts(entries);
  if (all) return eligible.slice(0, limit);

  const selected = [];
  const coveredMedia = new Set();
  for (const entry of eligible) {
    const mediaSlug = entry.draft.mediaSlug;
    if (!mediaSlug || coveredMedia.has(mediaSlug)) continue;
    selected.push(entry);
    coveredMedia.add(mediaSlug);
    if (selected.length >= limit) return selected;
  }
  return selected;
}
