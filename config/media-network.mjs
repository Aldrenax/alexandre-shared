/**
 * Canonical, deployable configuration for the Alexandre media network.
 *
 * This file intentionally contains no secret, Telegram numeric identifier,
 * affiliate URL or mutable metric. Runtime data lives under /var/lib on the
 * VPS and is joined by stable media/source identifiers.
 */

import { EDITORIAL_BRIEFS } from './editorial-briefs.mjs';

const dailyCadence = Object.freeze({
  newsTargetPerWeek: 7,
  videoArticle: 'on-public-long-video',
  guideTargetPerWeek: 1,
  qualityOverridesQuota: true,
});

export const MEDIA_NETWORK = Object.freeze([
  {
    slug: 'chaimbault',
    name: 'Alexandre Chaimbault',
    channelId: 'UCRxbwf6AEhLDviL8YTSqTsg',
    siteUrl: 'https://alexandrechaimbault.com',
    topicName: '🎥 Alexandre Chaimbault',
    editorialEnabled: true,
    editorialBrief: EDITORIAL_BRIEFS.chaimbault,
    risk: 'standard',
    cadence: dailyCadence,
    sections: ['actualites', 'videos', 'guides'],
    newsCategories: ['actualite', 'analyse', 'tendance', 'creator', 'ia', 'entrepreneuriat', 'productivite'],
    guideTopics: ['comparatif', 'tutoriel', 'finance', 'business', 'productivite', 'marketing', 'crypto', 'ia'],
    topicKeywords: [
      'entrepreneur', 'intelligence artificielle', 'IA', 'SaaS', 'YouTube',
      'creator economy', 'productivité', 'automatisation', 'business',
      'OpenAI', 'ChatGPT', 'GPT', 'Copilot', 'Gemini', 'agent IA',
    ],
    xQueries: [
      'actualités officielles intelligence artificielle SaaS créateurs entrepreneurs France',
      'annonce officielle YouTube créateurs monétisation outils IA',
    ],
    officialXQueries: [
      { query: 'annonces officielles OpenAI et YouTube pour les créateurs et entrepreneurs', allowedHandles: ['OpenAI', 'YouTubeCreators'] },
    ],
  },
  {
    slug: 'tesla-tech',
    name: 'Alexandre - Tesla & Tech',
    channelId: 'UCsUckxZM0uwfeiUSic7jo9g',
    siteUrl: 'https://alexandre-tesla.fr',
    topicName: '🚗 Tesla & Tech',
    editorialEnabled: true,
    editorialBrief: EDITORIAL_BRIEFS['tesla-tech'],
    risk: 'product-safety',
    cadence: dailyCadence,
    sections: ['actualites', 'videos', 'guides'],
    newsCategories: ['actualite', 'lancement', 'autopilot-fsd', 'energy', 'recharge', 'finance', 'analyse', 'rumeur'],
    guideTopics: ['acheter', 'recharge', 'comparatif', 'usage', 'finance', 'energie'],
    topicKeywords: [
      'Tesla', 'Model 3', 'Model Y', 'Cybertruck', 'Supercharger', 'FSD',
      'Autopilot', 'Powerwall', 'robotaxi', 'véhicule électrique',
    ],
    xQueries: [
      'Tesla annonce officielle logiciel rappel livraison Europe France',
      'Tesla Model 3 Model Y Supercharger FSD nouveautés vérifiables',
    ],
    officialXQueries: [
      { query: 'annonces Tesla produit logiciel recharge sécurité', allowedHandles: ['Tesla', 'Tesla_AI', 'TeslaCharging'] },
    ],
  },
  {
    slug: 'affiliation',
    name: 'Alexandre - Affiliation & Référencement',
    channelId: 'UCYbqoW9BZ_ZIVw556kOBMaw',
    siteUrl: 'https://alexandre-affiliation.fr',
    topicName: '🔗 Affiliation & Référencement',
    editorialEnabled: true,
    editorialBrief: EDITORIAL_BRIEFS.affiliation,
    risk: 'commercial',
    cadence: dailyCadence,
    sections: ['actualites', 'videos', 'guides'],
    newsCategories: ['actualite', 'analyse', 'tutoriel', 'outil', 'strategie', 'cas-pratique'],
    guideTopics: ['debuter', 'seo', 'outils', 'strategie', 'cas-pratique'],
    topicKeywords: [
      'SEO', 'Google Search', 'Search Console', 'affiliation', 'référencement',
      'éditeur', 'monétisation', 'commission', 'programme partenaire',
    ],
    xQueries: [
      'Google Search annonce officielle SEO Search Console documentation',
      'programme affiliation annonce officielle éditeurs France',
    ],
    officialXQueries: [
      { query: 'annonces officielles Google Search référencement', allowedHandles: ['googlesearchc'] },
    ],
  },
  {
    slug: 'logiciels',
    name: 'Alexandre - Logiciels & Marketing',
    channelId: 'UCy2Eqe9jLoEGGZ0cO4Eiobw',
    siteUrl: 'https://alexandre-logiciels.fr',
    topicName: '🧰 Logiciels & Marketing',
    editorialEnabled: true,
    editorialBrief: EDITORIAL_BRIEFS.logiciels,
    risk: 'standard',
    cadence: dailyCadence,
    sections: ['actualites', 'videos', 'guides'],
    newsCategories: ['actualite', 'analyse', 'comparatif', 'tutoriel', 'automation', 'marketing'],
    guideTopics: ['comparatif', 'tutoriel', 'automation', 'marketing', 'no-code'],
    topicKeywords: [
      'logiciel', 'SaaS', 'marketing', 'automatisation', 'no-code', 'IA',
      'open source', 'CRM', 'email marketing', 'productivité', 'OpenAI',
      'ChatGPT', 'GPT', 'GitHub', 'Copilot', 'Gemini', 'agent IA',
    ],
    xQueries: [
      'annonce officielle logiciel SaaS IA marketing automatisation changelog',
      'nouveau logiciel lancement officiel productivité no-code open source',
    ],
    officialXQueries: [
      { query: 'annonces officielles logiciels IA marketing', allowedHandles: ['OpenAI', 'github'] },
    ],
  },
  {
    slug: 'investissement',
    name: 'Alexandre - Finance & Investissement',
    channelId: 'UCzpgcvjuTVRVj_ZQGzrtdZg',
    siteUrl: 'https://alexandre-investissement.fr',
    topicName: '📈 Finance & Investissement',
    editorialEnabled: true,
    editorialBrief: EDITORIAL_BRIEFS.investissement,
    risk: 'regulated-finance',
    cadence: dailyCadence,
    sections: ['actualites', 'videos', 'guides'],
    newsCategories: ['actualite', 'epargne', 'bourse', 'crypto', 'immobilier', 'fiscalite', 'retraite', 'analyse', 'guide'],
    guideTopics: ['debuter', 'bourse-etf', 'crypto', 'epargne-livrets', 'fiscalite', 'immobilier', 'retraite-pension', 'comparatif-plateformes'],
    topicKeywords: [
      'AMF', 'BCE', 'Banque de France', 'bourse', 'ETF', 'PEA', 'épargne',
      'crypto-actif', 'Bitcoin', 'taux', 'inflation', 'paiement', 'cash', 'euro',
    ],
    xQueries: [
      'AMF BCE Banque de France annonce officielle investissement épargne crypto',
      'résultats officiels taux inflation marchés France Europe',
    ],
    officialXQueries: [
      { query: 'annonces officielles épargne taux marchés France Europe', allowedHandles: ['AMF_actu', 'ecb', 'banquedefrance'] },
    ],
  },
  {
    slug: 'entreprise',
    name: 'Alexandre - Entreprise & Comptabilité',
    channelId: 'UCVeL8ebsVmid_dGxQOQghtg',
    siteUrl: 'https://alexandre-entreprise.fr',
    topicName: '🏢 Entreprise & Comptabilité',
    editorialEnabled: true,
    editorialBrief: EDITORIAL_BRIEFS.entreprise,
    risk: 'legal-tax',
    cadence: dailyCadence,
    sections: ['actualites', 'videos', 'guides'],
    newsCategories: ['actualite', 'analyse', 'juridique', 'fiscalite', 'gestion', 'creation', 'comptabilite'],
    guideTopics: ['creation', 'juridique', 'fiscalite', 'comptabilite', 'gestion'],
    topicKeywords: [
      'entreprise', 'micro-entreprise', 'SASU', 'TVA', 'facturation',
      'Urssaf', 'BOFiP', 'Légifrance', 'comptabilité', 'fiscalité',
      'crédit d’impôt', 'C3IV',
    ],
    xQueries: [
      'annonce officielle entreprise fiscalité Urssaf BOFiP Service Public France',
      'facturation électronique entreprise décret calendrier officiel',
    ],
    officialXQueries: [
      { query: 'annonces officielles entreprise fiscalité cotisations France', allowedHandles: ['urssaf', 'servicepublicfr'] },
    ],
  },
  {
    slug: 'daily',
    name: 'Alexandre Chaimbault Daily',
    channelId: 'UCohvIxNPDES9lM-XykW9JTA',
    siteUrl: null,
    topicName: '📹 Daily',
    editorialEnabled: false,
    pausedReason: 'Aucune production éditoriale demandée pour le moment.',
    risk: 'standard',
    cadence: null,
    sections: [],
    newsCategories: [],
    guideTopics: [],
    topicKeywords: [],
    xQueries: [],
  },
  {
    slug: 'askoptimize',
    name: 'AskOptimize',
    channelId: 'UCUDt7YSjRoIsa-Zwsk7178Q',
    siteUrl: 'https://askoptimize.com',
    topicName: '🔎 AskOptimize',
    editorialEnabled: false,
    pausedReason: 'Aucune production éditoriale demandée pour le moment.',
    risk: 'commercial',
    cadence: null,
    sections: [],
    newsCategories: [],
    guideTopics: [],
    topicKeywords: [],
    xQueries: [],
  },
]);

// Une source secondaire enrichit et corrobore les sujets, mais son timeout ne
// constitue pas une panne du moteur. Par défaut, seules les sources officielles
// sont donc requises ; chaque complément officiel fragile peut encore être
// explicitement rendu optionnel avec `required: false`.
const source = (value) => Object.freeze({
  required: value.required ?? Boolean(value.official),
  ...value,
});

export const MEDIA_SOURCES = Object.freeze([
  // Réseau principal / technologie / entrepreneuriat
  source({ id: 'openai-news', name: 'OpenAI News', type: 'rss', url: 'https://openai.com/news/rss.xml', tier: 0, official: true, media: ['chaimbault', 'logiciels'] }),
  source({ id: 'google-search-blog', name: 'Google Search Central Blog', type: 'rss', url: 'https://developers.google.com/search/blog/feed.xml', tier: 1, official: true, media: ['chaimbault', 'affiliation'] }),
  source({ id: 'github-changelog', name: 'GitHub Changelog', type: 'rss', url: 'https://github.blog/changelog/feed/', tier: 0, official: true, media: ['chaimbault', 'logiciels'] }),
  source({ id: 'cloudflare-blog', name: 'Cloudflare Blog', type: 'rss', url: 'https://blog.cloudflare.com/rss/', tier: 0, official: true, media: ['chaimbault', 'logiciels'] }),
  source({ id: 'frenchweb', name: 'Frenchweb', type: 'rss', url: 'https://www.frenchweb.fr/feed', tier: 2, official: false, media: ['chaimbault', 'logiciels', 'entreprise'] }),
  source({ id: 'numerama', name: 'Numerama', type: 'rss', url: 'https://www.numerama.com/feed/', tier: 2, official: false, media: ['chaimbault', 'logiciels'] }),
  source({ id: 'siecledigital', name: 'Siècle Digital', type: 'rss', url: 'https://siecledigital.fr/feed/', tier: 2, official: false, media: ['chaimbault', 'logiciels'] }),
  source({ id: 'maddyness', name: 'Maddyness', type: 'rss', url: 'https://www.maddyness.com/feed/', tier: 2, official: false, media: ['chaimbault', 'logiciels', 'entreprise'] }),

  // Tesla
  // Les pages tesla.com et ir.tesla.com refusent durablement le VPS (HTTP
  // 403). Elles restent des sondes de récupération quotidiennes, sans
  // contournement ; les flux officiels accessibles assurent la collecte utile.
  source({ id: 'tesla-ir', name: 'Tesla Investor Relations', type: 'page', pageMode: 'links', required: false, quarantineAfterFailures: 1, quarantineRetryHours: 24, url: 'https://ir.tesla.com/', tier: 1, official: true, media: ['tesla-tech'] }),
  source({ id: 'tesla-learn', name: 'Tesla Learn', type: 'page', pageMode: 'reference', required: false, quarantineAfterFailures: 1, quarantineRetryHours: 24, url: 'https://www.tesla.com/learn', tier: 1, official: true, media: ['tesla-tech'] }),
  source({ id: 'tesla-release-notes', name: 'Tesla Software Release Notes', type: 'page', required: false, quarantineAfterFailures: 1, quarantineRetryHours: 24, url: 'https://www.tesla.com/support/software-release-notes', tier: 1, official: true, media: ['tesla-tech'] }),
  source({ id: 'tesla-youtube', name: 'Tesla — chaîne YouTube officielle', type: 'rss', itemTitlePrefix: 'Tesla —', required: false, url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC5WjFrtBdufl6CZojX3D8dQ', tier: 1, official: true, media: ['tesla-tech'] }),
  source({ id: 'tesla-sec-filings', name: 'Tesla — dépôts SEC', companyName: 'Tesla', type: 'api', apiProfile: 'sec-company-submissions', apiCik: '1318605', apiForms: ['8-K', '10-K', '10-Q', 'DEF 14A', 'SD'], required: false, url: 'https://data.sec.gov/submissions/CIK0001318605.json', tier: 0, official: true, media: ['tesla-tech'] }),
  source({ id: 'rappelconso-tesla', name: 'RappelConso — Tesla', type: 'rss', required: false, url: 'https://rappel.conso.gouv.fr/rss?q=tesla', tier: 0, official: true, media: ['tesla-tech'] }),
  source({ id: 'nhtsa-recalls', name: 'NHTSA Recalls API', type: 'api', url: 'https://api.nhtsa.gov/recalls/recallsByVehicle?make=Tesla&model=Model%20Y&modelYear=2025', tier: 0, official: true, media: ['tesla-tech'] }),
  source({ id: 'electrek-tesla', name: 'Electrek Tesla', type: 'rss', url: 'https://electrek.co/guides/tesla/feed/', tier: 2, official: false, media: ['tesla-tech'] }),
  source({ id: 'teslarati', name: 'Teslarati', type: 'rss', url: 'https://www.teslarati.com/feed/', tier: 2, official: false, media: ['tesla-tech'] }),
  source({ id: 'automobile-propre-tesla', name: 'Automobile Propre Tesla', type: 'rss', url: 'https://www.automobile-propre.com/tag/tesla/feed/', tier: 2, official: false, media: ['tesla-tech'] }),

  // SEO et affiliation
  source({ id: 'google-search-doc-updates', name: 'Google Search Documentation Updates', type: 'rss', url: 'https://developers.google.com/search/updates/search_docs_updates.rss', tier: 0, official: true, media: ['affiliation'] }),
  source({ id: 'google-search-status', name: 'Google Search Status Dashboard', type: 'rss', required: false, url: 'https://status.search.google.com/en/feed.atom?hl=fr', tier: 0, official: true, media: ['affiliation'] }),
  source({ id: 'abondance', name: 'Abondance', type: 'rss', url: 'https://www.abondance.com/feed', tier: 2, official: false, media: ['affiliation'] }),
  source({ id: 'webrankinfo', name: 'WebRankInfo', type: 'rss', url: 'https://www.webrankinfo.com/dossiers/feed', tier: 2, official: false, media: ['affiliation'] }),
  source({ id: 'search-engine-journal', name: 'Search Engine Journal', type: 'rss', url: 'https://www.searchenginejournal.com/feed/', tier: 2, official: false, media: ['affiliation'] }),
  source({ id: 'search-engine-land', name: 'Search Engine Land', type: 'rss', required: false, url: 'https://searchengineland.com/feed', tier: 2, official: false, media: ['affiliation'] }),
  source({ id: 'search-engine-watch', name: 'Search Engine Watch', type: 'rss', required: false, url: 'https://searchenginewatch.com/feed/', tier: 2, official: false, media: ['affiliation'] }),
  source({ id: 'moz-blog', name: 'Moz Blog', type: 'rss', url: 'https://moz.com/posts/rss/blog', tier: 2, official: false, media: ['affiliation'] }),

  // Logiciels
  source({ id: 'product-hunt', name: 'Product Hunt', type: 'rss', url: 'https://www.producthunt.com/feed', tier: 3, official: false, media: ['logiciels'] }),
  source({ id: 'bdm', name: 'Blog du Modérateur', type: 'rss', url: 'https://www.blogdumoderateur.com/feed/', tier: 2, official: false, media: ['logiciels'] }),

  // Finance et investissement
  source({ id: 'amf-news', name: 'AMF À la une', type: 'page', pageMode: 'links', url: 'https://www.amf-france.org/fr/actualites-publications/la-une', tier: 1, official: true, media: ['investissement'] }),
  source({ id: 'ecb-press', name: 'BCE Communiqués et prises de parole', type: 'rss', url: 'https://www.ecb.europa.eu/rss/press.html', tier: 0, official: true, media: ['investissement'] }),
  source({ id: 'ecb-blog', name: 'BCE Blog', type: 'rss', url: 'https://www.ecb.europa.eu/rss/blog.html', tier: 0, official: true, media: ['investissement'] }),
  // Source officielle complémentaire. L'AMF et la BCE restent les références
  // requises : une indisponibilité isolée de la Banque de France ne doit pas
  // immobiliser l'ensemble du réseau éditorial.
  source({ id: 'banque-france-news', name: 'Banque de France Actualités', type: 'page', pageMode: 'links', required: false, url: 'https://www.banque-france.fr/fr/actualites-et-evenements', tier: 1, official: true, media: ['investissement'] }),
  source({ id: 'franceinfo-economie', name: 'Franceinfo Économie', type: 'rss', url: 'https://www.franceinfo.fr/economie.rss', tier: 2, official: false, media: ['investissement'] }),
  source({ id: 'cointribune', name: 'Cointribune', type: 'rss', url: 'https://www.cointribune.com/feed/', tier: 2, official: false, media: ['investissement'] }),
  source({ id: 'journal-du-coin', name: 'Journal du Coin', type: 'rss', url: 'https://journalducoin.com/feed/', tier: 2, official: false, media: ['investissement'] }),

  // Entreprise et réglementation
  source({ id: 'service-public-pro', name: 'Service Public Entreprendre', type: 'rss', url: 'https://www.service-public.fr/abonnements/rss/actu-actu-pro.rss', tier: 0, official: true, media: ['entreprise'] }),
  source({ id: 'economie-actualites', name: 'Ministère de l’Économie — Actualités', type: 'rss', required: false, url: 'https://www.economie.gouv.fr/rss/toutesactualites', tier: 0, official: true, media: ['entreprise'] }),
  // La page détaillée du ministère peut refuser les requêtes du VPS alors
  // que cette fiche DGFiP reste accessible et documente le dispositif. Sa
  // date de modification constitue l'événement, pas sa date de création 2024.
  source({ id: 'impots-c3iv', name: 'impots.gouv.fr — C3IV', type: 'page', pageDateMode: 'modified', required: false, url: 'https://www.impots.gouv.fr/professionnel/questions/puis-je-pretendre-au-credit-dimpot-au-titre-des-investissements-en-faveur', tier: 0, official: true, media: ['entreprise'] }),
  source({ id: 'bofip-rss', name: 'BOFiP Flux RSS', type: 'rss', required: false, url: 'https://bofip.impots.gouv.fr/bofip/ext/rss/last-rss.xml', tier: 1, official: true, media: ['entreprise'] }),
  source({ id: 'legifrance-api', name: 'Légifrance Open Data et API', type: 'page', pageMode: 'reference', required: false, url: 'https://www.legifrance.gouv.fr/contenu/pied-de-page/open-data-et-api', tier: 1, official: true, media: ['entreprise'] }),
  source({ id: 'urssaf-news', name: 'Urssaf Actualités', type: 'page', pageMode: 'links', required: false, url: 'https://www.urssaf.fr/accueil/actualites.html', tier: 1, official: true, media: ['entreprise'] }),
  source({ id: 'bfm-economie', name: 'BFM Économie', type: 'rss', url: 'https://www.bfmtv.com/rss/economie/', tier: 2, official: false, media: ['entreprise'] }),
]);

export const MEDIA_ENGINE_DEFAULTS = Object.freeze({
  timezone: 'Europe/Paris',
  runtimeDir: '/var/lib/alexandre-media-engine',
  publicationMode: 'draft',
  sourceFailureQuarantineThreshold: 3,
  candidateMaxAgeHours: 72,
  minimumCandidateScore: 70,
  cadenceFallbackMaxAgeHours: 120,
  cadenceFallbackMinimumScore: 60,
  shadowDaysRequired: 7,
  banner: {
    width: 1200,
    height: 630,
    format: 'webp',
  },
  models: {
    editorialEnv: 'HERMES_EDITORIAL_MODEL',
    guideEnv: 'HERMES_GUIDE_MODEL',
    researchTool: 'x_search',
  },
});
