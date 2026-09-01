import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshableThumbnailDrafts, representativeThumbnailBatch } from '../media/thumbnail-refresh.mjs';

const entry = (path, mediaSlug, contentType) => ({ path, draft: { mediaSlug, contentType } });

test('thumbnail refresh: ne sélectionne que les Actualités et Guides', () => {
  const entries = [
    entry('/d/video.json', 'chaimbault', 'video'),
    entry('/d/news.json', 'chaimbault', 'news'),
    entry('/d/guide.json', 'tesla-tech', 'guide'),
  ];
  assert.deepEqual(refreshableThumbnailDrafts(entries).map((item) => item.draft.contentType), ['guide', 'news']);
});

test('thumbnail refresh: tous les contenus éligibles sont sélectionnés sans plafond arbitraire', () => {
  const entries = [
    entry('/d/chaimbault-b.json', 'chaimbault', 'news'),
    entry('/d/chaimbault-a.json', 'chaimbault', 'guide'),
    entry('/d/tesla-a.json', 'tesla-tech', 'news'),
    entry('/d/video.json', 'logiciels', 'video'),
  ];
  assert.deepEqual(
    representativeThumbnailBatch(entries, { limit: 1 }).map((item) => item.path),
    ['/d/chaimbault-a.json', '/d/chaimbault-b.json', '/d/tesla-a.json'],
  );
});
