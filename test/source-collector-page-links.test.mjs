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

test('registre sources: les flux officiels complémentaires sont RSS et optionnels', () => {
  const googleSearchStatus = MEDIA_SOURCES.find((source) => source.id === 'google-search-status');
  const economieActualites = MEDIA_SOURCES.find((source) => source.id === 'economie-actualites');
  const bofip = MEDIA_SOURCES.find((source) => source.id === 'bofip-rss');

  assert.deepEqual(
    [googleSearchStatus, economieActualites, bofip].map((source) => ({
      type: source.type,
      required: source.required,
      official: source.official,
    })),
    [
      { type: 'rss', required: false, official: true },
      { type: 'rss', required: false, official: true },
      { type: 'rss', required: false, official: true },
    ],
  );
  assert.equal(googleSearchStatus.url, 'https://status.search.google.com/en/feed.atom?hl=fr');
  assert.equal(economieActualites.url, 'https://www.economie.gouv.fr/rss/toutesactualites');
  assert.equal(bofip.url, 'https://bofip.impots.gouv.fr/bofip/ext/rss/last-rss.xml');
});

test('registre sources: Search Engine Land reste une source secondaire optionnelle', () => {
  const source = MEDIA_SOURCES.find((entry) => entry.id === 'search-engine-land');

  assert.equal(source.type, 'rss');
  assert.equal(source.url, 'https://searchengineland.com/feed');
  assert.equal(source.tier, 2);
  assert.equal(source.official, false);
  assert.equal(source.required, false);
  assert.deepEqual(source.media, ['affiliation']);
});

test('collecteur RSS BOFiP: infère la date depuis la description puis le suffixe URL', async () => {
  const source = MEDIA_SOURCES.find((entry) => entry.id === 'bofip-rss');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel><title>BOFiP</title>
      <item>
        <guid>description</guid>
        <title>TVA - Nouvelle règle pour les entreprises</title>
        <link>https://bofip.impots.gouv.fr/bofip/1-PGP.html/identifiant=BOI-TVA-20260812</link>
        <description>Doctrine mise à jour (identifiant juridique BOI-TVA; publié le 13/08/2026)</description>
      </item>
      <item>
        <guid>suffixe</guid>
        <title>IS - Obligations déclaratives des sociétés</title>
        <link>https://bofip.impots.gouv.fr/bofip/2-PGP.html/identifiant=BOI-IS-20260812</link>
        <description>Doctrine mise à jour sans date explicite</description>
      </item>
    </channel></rss>`;
  const response = {
    ok: true,
    status: 200,
    url: source.url,
    headers: new Headers({ 'content-type': 'application/rss+xml' }),
    text: async () => xml,
  };

  const collected = await collectSource(source, { fetchImpl: async () => response });

  assert.equal(collected.items[0].publishedAt, '2026-08-13T00:00:00.000Z');
  assert.equal(collected.items[1].publishedAt, '2026-08-12T00:00:00.000Z');
});

test('collecteur RSS: ne déduit aucune date BOFiP hors source ou depuis une date invalide', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel><title>Test</title>
      <item>
        <guid>date-invalide</guid>
        <title>TVA - Information sans date valide</title>
        <link>https://example.test/article-20260231</link>
        <description>Information publiée le 31/02/2026</description>
      </item>
    </channel></rss>`;
  const response = {
    ok: true,
    status: 200,
    url: 'https://example.test/feed.xml',
    headers: new Headers({ 'content-type': 'application/rss+xml' }),
    text: async () => xml,
  };
  const otherSource = {
    id: 'other-rss', name: 'Autre RSS', type: 'rss', url: response.url,
    tier: 0, official: true, media: ['entreprise'],
  };
  const bofipSource = { ...otherSource, id: 'bofip-rss' };

  const [other, bofip] = await Promise.all([
    collectSource(otherSource, { fetchImpl: async () => response }),
    collectSource(bofipSource, { fetchImpl: async () => response }),
  ]);

  assert.equal(other.items[0].publishedAt, null);
  assert.equal(bofip.items[0].publishedAt, null);
});

test('collecteur API NHTSA: les dates jour-mois sont interprétées sans ambiguïté', async () => {
  const source = {
    id: 'nhtsa-recalls',
    name: 'NHTSA Recalls API',
    type: 'api',
    url: 'https://api.nhtsa.gov/recalls',
    tier: 0,
    official: true,
    media: ['tesla-tech'],
  };
  const response = {
    ok: true,
    status: 200,
    url: source.url,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ results: [
      { NHTSACampaignNumber: '24V935000', Component: 'CAMERA', ReportReceivedDate: '07/01/2025' },
      { NHTSACampaignNumber: '26V315000', Component: 'SEAT BELTS', ReportReceivedDate: '19/05/2026' },
    ] }),
  };

  const collected = await collectSource(source, { fetchImpl: async () => response });

  assert.equal(collected.items[0].publishedAt, '2025-01-07T00:00:00.000Z');
  assert.equal(collected.items[1].publishedAt, '2026-05-19T00:00:00.000Z');
});
