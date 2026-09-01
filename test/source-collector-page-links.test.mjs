import assert from 'node:assert/strict';
import test from 'node:test';

import { MEDIA_SOURCES } from '../config/media-network.mjs';
import { collectSource, enrichCandidateEvidence } from '../media/source-collector.mjs';

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

test('registre sources: les flux officiels complémentaires restent optionnels', () => {
  const googleSearchStatus = MEDIA_SOURCES.find((source) => source.id === 'google-search-status');
  const dgeActualites = MEDIA_SOURCES.find((source) => source.id === 'dge-actualites');
  const bofip = MEDIA_SOURCES.find((source) => source.id === 'bofip-rss');

  assert.deepEqual([googleSearchStatus, dgeActualites, bofip].map((source) => source.required), [false, false, false]);
  assert.equal([googleSearchStatus, dgeActualites, bofip].every((source) => source.official), true);
  assert.equal(googleSearchStatus.type, 'rss');
  assert.equal(dgeActualites.type, 'page');
  assert.equal(dgeActualites.pageMode, 'links');
  assert.equal(googleSearchStatus.url, 'https://status.search.google.com/en/feed.atom?hl=fr');
  assert.equal(dgeActualites.url, 'https://www.entreprises.gouv.fr/la-dge/actualites');
  assert.equal(bofip.url, 'https://bofip.impots.gouv.fr/bofip/ext/rss/last-rss.xml');
});

test('registre sources: les fallbacks officiels Affiliation et Entreprise sont accessibles sans endpoint bloqué', () => {
  const affilae = MEDIA_SOURCES.find((source) => source.id === 'affilae-news');
  const awin = MEDIA_SOURCES.find((source) => source.id === 'awin-news');
  const inpi = MEDIA_SOURCES.find((source) => source.id === 'inpi-news');
  const dge = MEDIA_SOURCES.find((source) => source.id === 'dge-actualites');
  const servicePublicPage = MEDIA_SOURCES.find((source) => source.id === 'service-public-pro-page');

  assert.equal(affilae.url, 'https://affilae.com/fr/category/actualites/feed/');
  assert.deepEqual(affilae.topicRoutes, ['affiliation']);
  assert.equal(awin.linkPathPattern, '^/fr/actualites-et-evenements/post/');
  assert.deepEqual(awin.topicRoutes, ['affiliation']);
  assert.equal(inpi.url, 'https://www.inpi.fr/rss.xml');
  assert.equal(dge.linkPathPattern, '^/la-dge/actualites/');
  assert.equal(servicePublicPage.url, 'https://entreprendre.service-public.gouv.fr/actualites');
});

test('collecteur page: conserve la date et le résumé de la carte officielle ciblée', async () => {
  const source = {
    id: 'dge-actualites', name: 'DGE', type: 'page', pageMode: 'links',
    linkPathPattern: '^/la-dge/actualites/', url: 'https://www.entreprises.gouv.fr/la-dge/actualites',
    tier: 0, official: true, media: ['entreprise'],
  };
  const html = `<main>
    <a href="/espace-entreprises">Un dossier permanent suffisamment long mais hors actualités</a>
    <a href="/la-dge/actualites/facturation-electronique-septembre">La facturation d&#039;entreprise entre en vigueur pour les professionnels</a>
    <p>Toutes les entreprises doivent pouvoir recevoir une facture électronique.</p><p>31 août 2026</p>
    <a href="/la-dge/actualites/autre-sujet">Une deuxième actualité officielle sans confusion de date</a>
    <p>20 août 2026</p>
  </main>`;
  const response = {
    ok: true, status: 200, url: source.url,
    headers: new Headers({ 'content-type': 'text/html' }), text: async () => html,
  };

  const collected = await collectSource(source, { fetchImpl: async () => response });

  assert.equal(collected.items.length, 2);
  assert.equal(collected.items[0].title, "La facturation d'entreprise entre en vigueur pour les professionnels");
  assert.equal(collected.items[0].publishedAt, '2026-08-31T00:00:00.000Z');
  assert.match(collected.items[0].excerpt, /Toutes les entreprises/u);
  assert.equal(collected.items[1].publishedAt, '2026-08-20T00:00:00.000Z');
});

test('collecteur page: refuse un challenge anti-bot HTTP 200 comme contenu sain', async () => {
  const source = {
    id: 'protected-official', name: 'Source protégée', type: 'page', pageMode: 'links',
    url: 'https://official.example/actualites', tier: 0, official: true, media: ['entreprise'],
  };
  const response = {
    ok: true, status: 200, url: source.url,
    headers: new Headers({ 'content-type': 'text/html' }),
    text: async () => '<html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></body></html>',
  };

  const collected = await collectSource(source, { fetchImpl: async () => response });

  assert.equal(collected.status, 'degraded');
  assert.equal(collected.errorKind, 'anti-bot-challenge');
  assert.equal(collected.items.length, 0);
  assert.match(collected.diagnostic, /sans contourner/u);
});

test('registre sources: la fiche C3IV utilise sa modification officielle comme date', () => {
  const source = MEDIA_SOURCES.find((entry) => entry.id === 'impots-c3iv');

  assert.equal(source.type, 'page');
  assert.equal(source.pageDateMode, 'modified');
  assert.equal(source.official, true);
  assert.equal(source.tier, 0);
  assert.equal(source.required, false);
});

test('collecteur page: une modification datée reste un événement frais et prouvé', async () => {
  const source = {
    id: 'official-updated-document', name: 'Fiche officielle', type: 'page',
    pageDateMode: 'modified', url: 'https://official.example/dispositif',
    tier: 0, official: true, media: ['entreprise'],
  };
  const html = `
    <html><head>
      <title>Crédit d'impôt pour l'industrie verte</title>
      <meta property="article:published_time" content="2024-03-26T00:00:00Z">
      <meta name="description" content="Conditions, taux et procédure du dispositif officiel.">
    </head><body><main>
      <p>Publié le 26/03/2024, modifié le 11/08/2026</p>
      <p>Le dispositif officiel détaille les entreprises et investissements éligibles.</p>
    </main></body></html>`;
  const response = {
    ok: true, status: 200, url: source.url,
    headers: new Headers({ 'content-type': 'text/html' }), text: async () => html,
  };

  const collected = await collectSource(source, { fetchImpl: async () => response });

  assert.equal(collected.items.length, 1);
  assert.equal(collected.items[0].publishedAt, '2026-08-11T00:00:00.000Z');
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

test('registre sources: toutes les sources secondaires restent non bloquantes', () => {
  const secondarySources = MEDIA_SOURCES.filter((source) => !source.official);
  const officialRequired = MEDIA_SOURCES.filter((source) => source.official && source.required !== false);

  assert.ok(secondarySources.length > 0);
  assert.ok(officialRequired.length > 0);
  assert.equal(secondarySources.every((source) => source.required === false), true);
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

test('registre sources Tesla: garde des sondes lentes et ajoute trois fallbacks officiels', () => {
  const ids = new Set(MEDIA_SOURCES.filter((source) => source.media.includes('tesla-tech')).map((source) => source.id));

  for (const id of ['tesla-ir', 'tesla-learn', 'tesla-release-notes']) {
    const source = MEDIA_SOURCES.find((entry) => entry.id === id);
    assert.equal(ids.has(id), true);
    assert.equal(source.required, false);
    assert.equal(source.quarantineAfterFailures, 1);
    assert.equal(source.quarantineRetryHours, 24);
  }
  assert.equal(ids.has('tesla-youtube'), true);
  assert.equal(ids.has('tesla-sec-filings'), true);
  assert.equal(ids.has('rappelconso-tesla'), true);
  for (const id of ['tesla-youtube', 'tesla-sec-filings', 'rappelconso-tesla']) {
    const source = MEDIA_SOURCES.find((entry) => entry.id === id);
    assert.equal(source.official, true);
    assert.ok(source.tier <= 1);
    assert.equal(source.required, false);
  }
  assert.match(MEDIA_SOURCES.find((source) => source.id === 'tesla-youtube').url, /UC5WjFrtBdufl6CZojX3D8dQ/);
  assert.equal(MEDIA_SOURCES.find((source) => source.id === 'tesla-youtube').itemTitlePrefix, 'Tesla —');
  assert.equal(MEDIA_SOURCES.find((source) => source.id === 'tesla-sec-filings').apiProfile, 'sec-company-submissions');
  assert.equal(MEDIA_SOURCES.find((source) => source.id === 'rappelconso-tesla').url, 'https://rappel.conso.gouv.fr/rss?q=tesla');
});

test('collecteur Tesla bloqué: la sonde 403 passe immédiatement en quarantaine quotidienne', async () => {
  const source = MEDIA_SOURCES.find((entry) => entry.id === 'tesla-ir');
  const result = await collectSource(source, {
    fetchImpl: async () => ({
      ok: false, status: 403, url: source.url,
      headers: new Headers(), text: async () => '',
    }),
    now: new Date('2026-09-01T08:00:00.000Z'),
  });

  assert.equal(result.status, 'quarantined');
  assert.equal(result.consecutiveFailures, 1);
  assert.equal(result.nextRetryAt, '2026-09-02T08:00:00.000Z');
});

test('collecteur RSS Tesla: ajoute le contexte officiel sans doubler un titre déjà préfixé', async () => {
  const source = MEDIA_SOURCES.find((entry) => entry.id === 'tesla-youtube');
  const response = {
    ok: true,
    status: 200,
    url: source.url,
    headers: new Headers({ 'content-type': 'application/atom+xml' }),
    text: async () => `<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Tesla</title>
        <entry><id>one</id><title>Pet Mode keeps your dog chillin’</title><link href="https://www.youtube.com/watch?v=one"/><published>2026-09-01T07:00:00Z</published></entry>
        <entry><id>two</id><title>Tesla Cathode Factory</title><link href="https://www.youtube.com/watch?v=two"/><published>2026-09-01T06:00:00Z</published></entry>
      </feed>`,
  };

  const collected = await collectSource(source, { fetchImpl: async () => response });

  assert.deepEqual(collected.items.map((item) => item.title), [
    'Tesla — Pet Mode keeps your dog chillin’',
    'Tesla Cathode Factory',
  ]);
});

test('collecteur SEC Tesla: transforme seulement les formulaires autorisés en preuves officielles', async () => {
  const source = MEDIA_SOURCES.find((entry) => entry.id === 'tesla-sec-filings');
  const response = {
    ok: true,
    status: 200,
    url: source.url,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({
      cik: '0001318605',
      name: 'Tesla, Inc.',
      filings: { recent: {
        accessionNumber: ['0001628280-26-049270', '0001104659-26-075213', '../../invalide'],
        filingDate: ['2026-07-23', '2026-06-17', '2026-06-01'],
        reportDate: ['2026-06-30', '2026-06-16', ''],
        acceptanceDateTime: ['2026-07-23T01:02:31.000Z', '2026-06-17T21:00:37.000Z', '2026-06-01T00:00:00.000Z'],
        form: ['10-Q', '4', '8-K'],
        items: ['', '', '2.02'],
        primaryDocument: ['tsla-20260630.htm', 'xslF345X06/tm2618092-2_4seq1.xml', '../escape.htm'],
      } },
    }),
  };

  const collected = await collectSource(source, { fetchImpl: async () => response });

  assert.equal(collected.status, 'healthy');
  assert.equal(collected.items.length, 1);
  assert.equal(collected.items[0].id, '0001628280-26-049270');
  assert.equal(collected.items[0].sourceOfficial, true);
  assert.equal(collected.items[0].kind, 'official-api');
  assert.equal(collected.items[0].publishedAt, '2026-07-23T01:02:31.000Z');
  assert.equal(collected.items[0].url, 'https://www.sec.gov/Archives/edgar/data/1318605/000162828026049270/tsla-20260630.htm');
  assert.match(collected.items[0].title, /Tesla.*10-Q/);
  assert.match(collected.items[0].title, /2026-07-23/);
});

test('collecteur: diagnostique un HTTP 403 et espace les essais après quarantaine', async () => {
  const source = {
    id: 'blocked-official', name: 'Source officielle', type: 'page',
    url: 'https://official.example/blocked', tier: 1, official: true, media: ['tesla-tech'],
  };
  let fetchCount = 0;
  const forbidden = {
    ok: false, status: 403, url: source.url,
    headers: new Headers(), text: async () => '',
  };
  const quarantined = await collectSource(source, {
    previous: { consecutiveFailures: 2, lastOkAt: '2026-08-01T00:00:00.000Z' },
    fetchImpl: async () => { fetchCount += 1; return forbidden; },
    now: new Date('2026-09-01T08:00:00.000Z'),
  });

  assert.equal(quarantined.status, 'quarantined');
  assert.equal(quarantined.errorKind, 'http-forbidden');
  assert.equal(quarantined.httpStatus, 403);
  assert.equal(quarantined.attemptedUrl, source.url);
  assert.equal(quarantined.quarantinedAt, '2026-09-01T08:00:00.000Z');
  assert.equal(quarantined.nextRetryAt, '2026-09-01T20:00:00.000Z');
  assert.match(quarantined.diagnostic, /sans contourner/);

  const deferred = await collectSource(source, {
    previous: quarantined,
    fetchImpl: async () => { fetchCount += 1; return forbidden; },
    now: new Date('2026-09-01T09:00:00.000Z'),
  });
  assert.equal(fetchCount, 1);
  assert.equal(deferred.status, 'quarantined');
  assert.equal(deferred.skipped, true);
  assert.equal(deferred.skipReason, 'quarantine-backoff');
  assert.equal(deferred.lastAttemptAt, '2026-09-01T08:00:00.000Z');
});

test('collecteur: retente une source quarantainée après temporisation et réinitialise son état', async () => {
  const source = {
    id: 'recovered-official', name: 'Source officielle', type: 'page', pageMode: 'reference',
    url: 'https://official.example/recovered', tier: 1, official: true, media: ['tesla-tech'],
  };
  const response = {
    ok: true, status: 200, url: source.url,
    headers: new Headers({ 'content-type': 'text/html' }), text: async () => '<html><title>Source rétablie</title></html>',
  };
  const recovered = await collectSource(source, {
    previous: {
      status: 'quarantined', consecutiveFailures: 3,
      nextRetryAt: '2026-09-01T08:00:00.000Z',
      errorKind: 'http-forbidden', httpStatus: 403,
    },
    fetchImpl: async () => response,
    now: new Date('2026-09-01T08:01:00.000Z'),
  });

  assert.equal(recovered.status, 'healthy');
  assert.equal(recovered.consecutiveFailures, 0);
  assert.equal(recovered.httpStatus, 200);
  assert.equal(recovered.lastAttemptAt, '2026-09-01T08:01:00.000Z');
  assert.equal(recovered.errorKind, undefined);
});

test('enrichissement: récupère la date déclarée de la page sans utiliser la date de collecte', async () => {
  const html = `<html><head>
    <meta property="article:published_time" content="2026-08-31T14:30:00+02:00">
  </head><body><main><h1>Nouvelle obligation de facturation électronique</h1>
    <p>${'Le texte officiel précise le calendrier et les entreprises concernées. '.repeat(8)}</p>
  </main></body></html>`;
  const response = {
    ok: true, status: 200, url: 'https://official.example/actualites/facturation',
    headers: new Headers({ 'content-type': 'text/html' }), text: async () => html,
  };
  const candidate = {
    title: 'Facturation électronique', publishedAt: null,
    sources: [{
      sourceId: 'official', tier: 0, official: true,
      url: response.url, publishedAt: null, pageDateMode: 'published',
    }],
  };

  const enriched = await enrichCandidateEvidence(candidate, { fetchImpl: async () => response });

  assert.equal(enriched.sources[0].publishedAt, '2026-08-31T12:30:00.000Z');
  assert.equal(enriched.publishedAt, '2026-08-31T12:30:00.000Z');
  assert.equal(enriched.sources[0].evidenceStatus, 'available');
});

test('enrichissement: une longue page de challenge HTTP 200 ne devient jamais une preuve disponible', async () => {
  const html = `<html><head><title>Just a moment...</title></head><body>
    <script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>
    <p>${'Checking your browser before accessing the official source. '.repeat(20)}</p>
  </body></html>`;
  const response = {
    ok: true, status: 200, url: 'https://official.example/protected',
    headers: new Headers({ 'content-type': 'text/html' }), text: async () => html,
  };
  const candidate = {
    title: 'Nouvelle règle officielle', publishedAt: null,
    sources: [{
      sourceId: 'protected-official', tier: 0, official: true,
      url: response.url, publishedAt: null, pageDateMode: 'published',
    }],
  };

  const enriched = await enrichCandidateEvidence(candidate, { fetchImpl: async () => response });

  assert.equal(enriched.sources[0].evidenceStatus, 'unavailable');
  assert.match(enriched.sources[0].evidenceError, /protection anti-bot détectée/u);
  assert.equal(enriched.sources[0].evidenceHash, undefined);
  assert.equal(enriched.evidenceAvailableCount, 0);
});
