import assert from 'node:assert/strict';
import test from 'node:test';

import { MEDIA_SOURCES } from '../config/media-network.mjs';
import { collectSource } from '../media/source-collector.mjs';

test('collecteur page: ignore la page source et ses variantes query ou langue', async () => {
  const source = {
    id: 'official-index',
    name: 'Autorité',
    type: 'page',
    pageMode: 'links',
    url: 'https://official.example/actualites/',
    tier: 1,
    official: true,
    media: ['entreprise'],
  };
  const html = `
    <main>
      <a href="/actualites/">Toute l'actualité officielle de cette autorité</a>
      <a href="/actualites/?page=2">Toute l'actualité officielle, page suivante</a>
      <a href="/actualites?hl=fr">Toute l'actualité officielle en français</a>
      <a href="/actualites?hl=en">All official news published in English</a>
      <a href="/actualites/nouvelle-regle">L'autorité publie une nouvelle règle pour les entreprises</a>
    </main>
  `;
  const response = {
    ok: true,
    status: 200,
    url: source.url,
    headers: new Headers({ 'content-type': 'text/html' }),
    text: async () => html,
  };

  const collected = await collectSource(source, { fetchImpl: async () => response });

  assert.deepEqual(collected.items.map((item) => item.url), [
    'https://official.example/actualites/nouvelle-regle',
  ]);
});

test('registre sources: Google Search Central utilise le RSS officiel', () => {
  const googleSearchBlog = MEDIA_SOURCES.find((source) => source.id === 'google-search-blog');

  assert.equal(googleSearchBlog.type, 'rss');
  assert.equal(googleSearchBlog.pageMode, undefined);
  assert.equal(googleSearchBlog.url, 'https://developers.google.com/search/blog/feed.xml');
});
