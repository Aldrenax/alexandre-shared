import { createHash } from 'node:crypto';

const USER_AGENT = 'AlexandreMediaEngine/0.3 (+https://alexandrechaimbault.com)';

class SourceHttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status}`);
    this.name = 'SourceHttpError';
    this.status = Number(status);
    this.url = url;
  }
}

function failureDetails(error) {
  const status = Number(error?.status);
  if (Number.isInteger(status)) {
    if ([401, 403].includes(status)) {
      return {
        kind: 'http-forbidden',
        status,
        diagnostic: `Accès refusé par la source (HTTP ${status}). Utiliser un flux ou une API officielle accessible, sans contourner la protection.`,
      };
    }
    if (status === 429) {
      return {
        kind: 'http-rate-limited',
        status,
        diagnostic: 'Limite de requêtes atteinte (HTTP 429). La source sera retentée après temporisation.',
      };
    }
    if (status >= 500) {
      return {
        kind: 'http-server',
        status,
        diagnostic: `La source officielle est indisponible côté serveur (HTTP ${status}).`,
      };
    }
    return {
      kind: 'http-client',
      status,
      diagnostic: `La source a rejeté la requête (HTTP ${status}). Vérifier l'URL et le contrat du flux.`,
    };
  }
  if (error?.sourceStage === 'parse') {
    return {
      kind: 'parse',
      status: null,
      diagnostic: 'La réponse a été reçue mais son format ne correspond plus au parseur attendu.',
    };
  }
  if (error?.sourceStage === 'challenge') {
    return {
      kind: 'anti-bot-challenge',
      status: null,
      diagnostic: 'La source a répondu avec une page de protection anti-bot au lieu du contenu attendu. Utiliser un flux ou un fallback officiel accessible, sans contourner la protection.',
    };
  }
  if (['AbortError', 'TimeoutError'].includes(error?.name) || /timed?\s*out|timeout/i.test(String(error?.message || ''))) {
    return {
      kind: 'timeout',
      status: null,
      diagnostic: 'La source n’a pas répondu avant l’expiration du délai.',
    };
  }
  return {
    kind: 'network',
    status: null,
    diagnostic: 'La collecte a échoué avant l’obtention d’une réponse exploitable.',
  };
}

function quarantineRetryHours(source, kind) {
  const configured = Number(source.quarantineRetryHours);
  if (Number.isFinite(configured) && configured > 0) return configured;
  if (kind === 'http-forbidden') return 12;
  if (kind === 'anti-bot-challenge') return 12;
  if (kind === 'http-rate-limited') return 2;
  return 1;
}

function deferredQuarantineResult(source, previous, now) {
  if (previous.status !== 'quarantined') return null;
  const nextRetryAt = Date.parse(previous.nextRetryAt || '');
  if (!Number.isFinite(nextRetryAt) || nextRetryAt <= now.getTime()) return null;
  const checkedAt = now.toISOString();
  return {
    sourceId: source.id,
    required: source.required !== false,
    status: 'quarantined',
    checkedAt,
    lastAttemptAt: previous.lastAttemptAt || previous.checkedAt || null,
    lastOkAt: previous.lastOkAt || null,
    consecutiveFailures: Number(previous.consecutiveFailures || 0),
    etag: previous.etag || null,
    lastModified: previous.lastModified || null,
    contentHash: previous.contentHash || null,
    error: previous.error || null,
    errorKind: previous.errorKind || null,
    httpStatus: previous.httpStatus ?? null,
    attemptedUrl: previous.attemptedUrl || source.url,
    diagnostic: previous.diagnostic || null,
    quarantinedAt: previous.quarantinedAt || previous.checkedAt || null,
    nextRetryAt: previous.nextRetryAt,
    skipped: true,
    skipReason: 'quarantine-backoff',
    items: [],
  };
}

function digest(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function decodeHtml(value = '') {
  return String(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function withoutBoilerplate(html = '') {
  return String(html)
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<(script|style|svg|noscript|nav|header|footer|form)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
}

function pageIdentity(value, base) {
  const url = new URL(value, base);
  const hostname = url.hostname.replace(/^www\./, '').toLowerCase();
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  return `${hostname}${pathname}`;
}

export function extractReadableText(html = '', maximumLength = 20_000) {
  return decodeHtml(withoutBoilerplate(html))
    .slice(0, maximumLength);
}

export function extractBalancedEvidence(html = '', maximumLength = 12_000) {
  const cleaned = withoutBoilerplate(html);
  const sections = [...cleaned.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2\b|$)/gi)]
    .map((match) => ({ heading: decodeHtml(match[1]), body: decodeHtml(match[2]) }))
    .filter((section) => section.heading && section.body);
  if (sections.length < 3) return extractReadableText(cleaned, maximumLength);

  const firstHeadingIndex = cleaned.search(/<h2\b/i);
  const introduction = decodeHtml(firstHeadingIndex > 0 ? cleaned.slice(0, firstHeadingIndex) : '').slice(0, 1_000);
  const framingLength = introduction.length
    + sections.reduce((total, section) => total + section.heading.length + 4, 0);
  const available = Math.max(0, maximumLength - framingLength);
  const sectionBudget = Math.max(80, Math.floor(available / sections.length));
  return [
    introduction,
    ...sections.map(({ heading, body }) => `${heading}: ${body}`.slice(0, sectionBudget)),
  ].filter(Boolean).join('\n\n').slice(0, maximumLength);
}

function pageLinks(html, source) {
  const items = [];
  const seen = new Set();
  const sourceUrl = new URL(source.url);
  const sourcePage = pageIdentity(sourceUrl);
  const cleaned = withoutBoilerplate(html);
  const matches = [...cleaned.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const linkPathPattern = source.linkPathPattern ? new RegExp(source.linkPathPattern, 'u') : null;
  for (const [index, match] of matches.entries()) {
    const title = decodeHtml(match[2]);
    if (title.length < 25 || title.length > 240) continue;
    let url;
    try { url = new URL(match[1], sourceUrl); } catch { continue; }
    if (!/^https?:$/.test(url.protocol)) continue;
    if (url.hostname.replace(/^www\./, '') !== sourceUrl.hostname.replace(/^www\./, '')) continue;
    if (linkPathPattern && !linkPathPattern.test(url.pathname)) continue;
    url.hash = '';
    const key = url.toString();
    if (seen.has(key) || pageIdentity(url) === sourcePage) continue;
    seen.add(key);
    // Les index officiels Awin, DGE et Service Public exposent
    // la date et le résumé juste après le lien de titre. Le segment est borné
    // par le lien suivant pour ne jamais emprunter la date d'une autre carte.
    const contextStart = Number(match.index || 0) + match[0].length;
    const contextEnd = Math.min(matches[index + 1]?.index ?? cleaned.length, contextStart + 4_000);
    const context = cleaned.slice(contextStart, contextEnd);
    items.push({
      id: `${source.id}:${digest(key).slice(0, 16)}`,
      sourceId: source.id,
      sourceTier: source.tier,
      sourceOfficial: source.official,
      sourcePolicy: source.sourcePolicy || null,
      title,
      url: key,
      excerpt: decodeHtml(context).slice(0, 1_200),
      publishedAt: contextualPublishedAt(context),
      author: source.name,
      media: source.media,
      topicRoutes: source.topicRoutes || [],
      pageDateMode: source.pageDateMode || 'published',
      kind: 'official-page-link',
    });
    if (items.length >= 30) break;
  }
  return items;
}

function validDate(value, fallback = null) {
  if (!value || Number.isNaN(Date.parse(value))) return fallback;
  return new Date(value).toISOString();
}

function validDayFirstDate(value, fallback = null) {
  const match = String(value || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return fallback;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return fallback;
  }
  return date.toISOString();
}

function validCompactDate(value, fallback = null) {
  const match = String(value || '').trim().match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return fallback;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return fallback;
  }
  return date.toISOString();
}

const FRENCH_MONTHS = Object.freeze({
  janvier: 1,
  fevrier: 2,
  mars: 3,
  avril: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  aout: 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  decembre: 12,
});

function validFrenchDate(value, fallback = null) {
  const normalized = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
  const match = normalized.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/);
  if (!match || !FRENCH_MONTHS[match[2]]) return fallback;
  const day = Number(match[1]);
  const month = FRENCH_MONTHS[match[2]];
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return fallback;
  }
  return date.toISOString();
}

function contextualPublishedAt(html = '') {
  const declared = html.match(/<time\b[^>]*datetime=["']([^"']+)/i)?.[1];
  if (declared) {
    const parsed = validDate(declared);
    if (parsed) return parsed;
  }
  const readable = decodeHtml(html);
  const labelled = readable.match(/(?:publi(?:é|e)|écrit|mise?\s+à\s+jour)\s+le\s+(\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1];
  if (labelled) {
    const parsed = validDayFirstDate(labelled);
    if (parsed) return parsed;
  }
  const french = readable.match(/(?:publi(?:é|e)|écrit|mise?\s+à\s+jour)\s+le\s+(\d{1,2}\s+[A-Za-zÀ-ÿ]+\s+\d{4})/i)?.[1];
  if (french) return validFrenchDate(french);
  // Les cartes DGE affichent la date auprès d'une icône calendrier, sans
  // libellé textuel. Le contexte est déjà borné à la carte courante.
  const unlabelledFrench = readable.match(/\b(\d{1,2}\s+[A-Za-zÀ-ÿ]+\s+\d{4})\b/i)?.[1];
  return validFrenchDate(unlabelledFrench);
}

function isAntiBotChallenge(text = '') {
  const sample = String(text).slice(0, 120_000);
  return /<title[^>]*>\s*Just a moment(?:\.\.\.)?\s*<\/title>/i.test(sample)
    || /(?:cf-chl-|cdn-cgi\/challenge-platform|challenge-platform\/scripts)/i.test(sample);
}

function rejectAntiBotChallenge(text = '') {
  if (!isAntiBotChallenge(text)) return;
  const challengeError = new Error('protection anti-bot détectée dans la réponse');
  challengeError.sourceStage = 'challenge';
  throw challengeError;
}

function rssPublishedAt(item, source) {
  const declared = validDate(item.isoDate || item.pubDate);
  if (declared || source.id !== 'bofip-rss') return declared;

  const description = decodeHtml(item.contentSnippet || item.summary || item.content || '');
  const describedDate = description.match(/publi(?:é|e) le\s+(\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1];
  if (describedDate) {
    const inferred = validDayFirstDate(describedDate);
    if (inferred) return inferred;
  }

  const compactSuffix = String(item.link || '').match(/(?:-|=)(\d{8})(?:[/?#]|$)/)?.[1];
  return validCompactDate(compactSuffix);
}

function requestHeaders(previous = {}) {
  const headers = {
    Accept: 'application/rss+xml, application/atom+xml, application/json, text/html, */*;q=0.5',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.7',
    'User-Agent': USER_AGENT,
  };
  if (previous.etag) headers['If-None-Match'] = previous.etag;
  if (previous.lastModified) headers['If-Modified-Since'] = previous.lastModified;
  return headers;
}

async function fetchSource(source, previous, fetchImpl, timeoutMs) {
  return fetchImpl(source.url, {
    headers: requestHeaders(previous),
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function parseRss(text, source) {
  let RssParser;
  try {
    ({ default: RssParser } = await import('rss-parser'));
  } catch {
    throw new Error('rss-parser est requis pour collecter les flux RSS');
  }
  const parser = new RssParser({ timeout: 15_000 });
  const feed = await parser.parseString(text);
  return (feed.items || []).slice(0, 30).map((item) => {
    const rawTitle = decodeHtml(item.title);
    const titlePrefix = decodeHtml(source.itemTitlePrefix || '');
    const prefixIdentity = titlePrefix.replace(/[\s—:|-]+$/g, '').toLowerCase();
    const normalizedTitle = rawTitle.toLowerCase();
    const alreadyPrefixed = normalizedTitle === prefixIdentity
      || normalizedTitle.startsWith(`${prefixIdentity} `)
      || normalizedTitle.startsWith(`${prefixIdentity}:`)
      || normalizedTitle.startsWith(`${prefixIdentity} —`);
    const title = titlePrefix && !alreadyPrefixed
      ? `${titlePrefix} ${rawTitle}`
      : rawTitle;
    return {
      id: item.guid || item.id || item.link || digest(item.title),
      sourceId: source.id,
      sourceTier: source.tier,
      sourceOfficial: source.official,
      sourcePolicy: source.sourcePolicy || null,
      title,
      url: item.link || '',
      excerpt: decodeHtml(item.contentSnippet || item.summary || item.content || '').slice(0, 1_200),
      publishedAt: rssPublishedAt(item, source),
      author: decodeHtml(item.creator || item.author || ''),
      media: source.media,
      topicRoutes: source.topicRoutes || [],
      kind: 'news',
    };
  }).filter((item) => item.title && item.url);
}

function declaredPageDates(html = '') {
  const declaredPublishedAt = validDate(
    html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)/i)?.[1]
      || html.match(/"datePublished"\s*:\s*"([^"]+)"/i)?.[1],
  );
  const readableText = decodeHtml(withoutBoilerplate(html));
  const visibleModifiedAt = readableText.match(/modifi(?:é|e)\s+le\s+(\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1];
  const declaredModifiedAt = validDate(
    html.match(/<meta[^>]+property=["']article:modified_time["'][^>]+content=["']([^"']+)/i)?.[1]
      || html.match(/"dateModified"\s*:\s*"([^"]+)"/i)?.[1],
  ) || validDayFirstDate(visibleModifiedAt);
  return { declaredPublishedAt, declaredModifiedAt };
}

function pageMetadata(html, source, previous = {}) {
  const canonical = html.match(/<link[^>]+rel=["'][^"']*canonical[^"']*["'][^>]+href=["']([^"']+)/i)?.[1]
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*canonical/i)?.[1]
    || source.url;
  const title = decodeHtml(
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1]
      || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      || source.name,
  );
  const excerpt = decodeHtml(
    html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)/i)?.[1]
      || '',
  );
  const { declaredPublishedAt, declaredModifiedAt } = declaredPageDates(html);
  const publishedAt = source.pageDateMode === 'modified'
    ? declaredModifiedAt || declaredPublishedAt
    : declaredPublishedAt;
  const contentHash = digest(html.replace(/\s+/g, ' '));
  const changed = Boolean(previous.contentHash && previous.contentHash !== contentHash);
  return {
    contentHash,
    items: source.pageMode === 'reference'
      ? []
      : source.pageMode === 'links'
        ? pageLinks(html, source)
        : changed || !previous.contentHash ? [{
      id: `${source.id}:${contentHash.slice(0, 16)}`,
      sourceId: source.id,
      sourceTier: source.tier,
      sourceOfficial: source.official,
      sourcePolicy: source.sourcePolicy || null,
      title,
      url: new URL(canonical, source.url).toString(),
      excerpt,
      publishedAt,
      author: source.name,
      media: source.media,
      topicRoutes: source.topicRoutes || [],
      pageDateMode: source.pageDateMode || 'published',
      kind: 'official-page-change',
        }] : [],
  };
}

export async function enrichCandidateEvidence(candidate, {
  fetchImpl = fetch,
  timeoutMs = 20_000,
  maximumSources = 4,
} = {}) {
  const sources = [];
  for (const source of (candidate.sources || []).slice(0, maximumSources)) {
    let enriched = { ...source };
    try {
      const response = await fetchImpl(source.url, {
        headers: requestHeaders(),
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get('content-type') || '';
      if (!/text\/html|text\/plain|application\/json/i.test(contentType)) throw new Error(`contenu non textuel: ${contentType}`);
      const text = await response.text();
      rejectAntiBotChallenge(text);
      const evidenceText = /application\/json/i.test(contentType)
        ? String(text).slice(0, 12_000)
        : extractBalancedEvidence(text, 12_000);
      const declaredDates = /text\/html/i.test(contentType) ? declaredPageDates(text) : {};
      const declaredAt = source.pageDateMode === 'modified'
        ? declaredDates.declaredModifiedAt || declaredDates.declaredPublishedAt
        : declaredDates.declaredPublishedAt;
      if (evidenceText.length >= 200) {
        enriched = {
          ...enriched,
          excerpt: evidenceText,
          publishedAt: enriched.publishedAt || declaredAt || null,
          evidenceHash: digest(evidenceText),
          evidenceRetrievedAt: new Date().toISOString(),
          evidenceStatus: 'available',
        };
      } else {
        enriched.evidenceStatus = 'insufficient';
      }
    } catch (error) {
      enriched.evidenceStatus = 'unavailable';
      enriched.evidenceError = String(error?.message || error);
    }
    sources.push(enriched);
  }
  const sourceDates = sources
    .map((source) => validDate(source.publishedAt))
    .filter(Boolean)
    .sort();
  return {
    ...candidate,
    publishedAt: candidate.publishedAt || sourceDates.at(-1) || null,
    sources,
    evidenceAvailableCount: sources.filter((source) => source.evidenceStatus === 'available').length,
    evidenceEnrichedAt: new Date().toISOString(),
  };
}

function apiItems(payload, source) {
  if (source.apiProfile === 'sec-company-submissions') {
    const recent = payload?.filings?.recent;
    const accessionNumbers = recent?.accessionNumber;
    if (!Array.isArray(accessionNumbers)) return [];
    const acceptedForms = new Set(source.apiForms || ['8-K', '10-K', '10-Q', 'DEF 14A', 'SD']);
    const cik = String(payload?.cik || source.apiCik || '').replace(/^0+/, '');
    if (!/^\d+$/.test(cik)) return [];
    const companyName = String(source.companyName || payload?.name || source.name).trim();
    const items = [];
    for (let index = 0; index < accessionNumbers.length && items.length < 50; index += 1) {
      const accessionNumber = String(accessionNumbers[index] || '').trim();
      const form = String(recent.form?.[index] || '').trim();
      const primaryDocument = String(recent.primaryDocument?.[index] || '').trim();
      if (!acceptedForms.has(form)
        || !/^\d{10}-\d{2}-\d{6}$/.test(accessionNumber)
        || !primaryDocument
        || primaryDocument.includes('..')
        || !/^[a-zA-Z0-9._/-]+$/.test(primaryDocument)) continue;
      const filingDate = String(recent.filingDate?.[index] || '').trim();
      const reportDate = String(recent.reportDate?.[index] || '').trim();
      const filingItems = String(recent.items?.[index] || '').trim();
      const archiveUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionNumber.replace(/-/g, '')}/${primaryDocument}`;
      const details = [
        `Formulaire ${form}`,
        filingDate ? `déposé le ${filingDate}` : '',
        reportDate ? `période de référence ${reportDate}` : '',
        filingItems ? `rubriques ${filingItems}` : '',
      ].filter(Boolean).join(', ');
      items.push({
        id: accessionNumber,
        sourceId: source.id,
        sourceTier: source.tier,
        sourceOfficial: source.official,
        sourcePolicy: source.sourcePolicy || null,
        title: `${companyName} publie un dépôt officiel ${form}${filingDate ? ` du ${filingDate}` : ''}`,
        url: archiveUrl,
        excerpt: `${details}.`,
        publishedAt: validDate(recent.acceptanceDateTime?.[index] || filingDate),
        author: source.name,
        media: source.media,
        kind: 'official-api',
        raw: {
          accessionNumber,
          form,
          filingDate,
          reportDate,
          items: filingItems,
          primaryDocument,
        },
      });
    }
    return items;
  }
  const values = Array.isArray(payload) ? payload : payload.results || payload.Results || payload.data || [];
  if (!Array.isArray(values)) return [];
  return values.slice(0, 50).map((item, index) => {
    const title = item.title || item.Title || item.Component || item.Subject || item.Manufacturer || `${source.name} #${index + 1}`;
    const excerpt = item.summary || item.Summary || item.Consequence || item.Remedy || item.description || '';
    const id = item.id || item.ID || item.NHTSACampaignNumber || item.campaignNumber || digest(JSON.stringify(item));
    return {
      id: String(id),
      sourceId: source.id,
      sourceTier: source.tier,
      sourceOfficial: source.official,
      sourcePolicy: source.sourcePolicy || null,
      title: decodeHtml(title),
      url: item.url || item.URL || source.url,
      excerpt: decodeHtml(excerpt).slice(0, 1_200),
      publishedAt: validDate(item.publishedAt || item.date)
        || validDayFirstDate(item.ReportReceivedDate),
      author: source.name,
      media: source.media,
      topicRoutes: source.topicRoutes || [],
      kind: 'official-api',
      raw: item,
    };
  });
}

export async function collectSource(source, {
  previous = {},
  fetchImpl = fetch,
  timeoutMs = 20_000,
  now = new Date(),
} = {}) {
  const startedAt = now.toISOString();
  const deferred = deferredQuarantineResult(source, previous, now);
  if (deferred) return deferred;
  try {
    const response = await fetchSource(source, previous, fetchImpl, timeoutMs);
    if (response.status === 304) {
      return {
        sourceId: source.id,
        required: source.required !== false,
        status: 'healthy',
        notModified: true,
        checkedAt: startedAt,
        lastAttemptAt: startedAt,
        lastOkAt: startedAt,
        consecutiveFailures: 0,
        etag: previous.etag || null,
        lastModified: previous.lastModified || null,
        contentHash: previous.contentHash || null,
        finalUrl: response.url || source.url,
        httpStatus: 304,
        items: [],
      };
    }
    if (!response.ok && !source.acceptedStatuses?.includes(response.status)) {
      throw new SourceHttpError(response.status, response.url || source.url);
    }

    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    rejectAntiBotChallenge(text);
    let items = [];
    let contentHash = digest(text);
    if (source.type === 'rss') {
      try {
        items = await parseRss(text, source);
      } catch (error) {
        const parseError = error instanceof Error ? error : new Error(String(error));
        parseError.sourceStage = 'parse';
        throw parseError;
      }
    } else if (source.type === 'api') {
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (error) {
        const parseError = new Error(`réponse API non JSON (${contentType || 'content-type inconnu'})`, { cause: error });
        parseError.sourceStage = 'parse';
        throw parseError;
      }
      items = apiItems(payload, source);
    } else if (source.type === 'page') {
      const page = pageMetadata(text, source, previous);
      items = page.items;
      contentHash = page.contentHash;
    } else {
      throw new Error(`collecte HTTP non prise en charge pour type=${source.type}`);
    }

    return {
      sourceId: source.id,
      required: source.required !== false,
      status: 'healthy',
      checkedAt: startedAt,
      lastAttemptAt: startedAt,
      lastOkAt: startedAt,
      consecutiveFailures: 0,
      etag: response.headers.get('etag') || previous.etag || null,
      lastModified: response.headers.get('last-modified') || previous.lastModified || null,
      contentHash,
      finalUrl: response.url || source.url,
      httpStatus: response.status,
      contentType,
      items,
    };
  } catch (error) {
    const consecutiveFailures = Number(previous.consecutiveFailures || 0) + 1;
    const configuredThreshold = Number(source.quarantineAfterFailures);
    const quarantineThreshold = Number.isInteger(configuredThreshold) && configuredThreshold > 0
      ? configuredThreshold
      : 3;
    const status = consecutiveFailures >= quarantineThreshold ? 'quarantined' : 'degraded';
    const details = failureDetails(error);
    const nextRetryAt = status === 'quarantined'
      ? new Date(now.getTime() + (quarantineRetryHours(source, details.kind) * 3_600_000)).toISOString()
      : null;
    return {
      sourceId: source.id,
      required: source.required !== false,
      status,
      checkedAt: startedAt,
      lastAttemptAt: startedAt,
      lastOkAt: previous.lastOkAt || null,
      consecutiveFailures,
      etag: previous.etag || null,
      lastModified: previous.lastModified || null,
      contentHash: previous.contentHash || null,
      error: String(error?.message || error),
      errorKind: details.kind,
      httpStatus: details.status,
      attemptedUrl: error?.url || source.url,
      diagnostic: details.diagnostic,
      quarantinedAt: status === 'quarantined'
        ? previous.quarantinedAt || startedAt
        : null,
      nextRetryAt,
      items: [],
    };
  }
}

export async function collectSources(sources, {
  previousBySource = {},
  concurrency = 4,
  ...options
} = {}) {
  const queue = [...sources];
  const results = [];
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length || 1)) }, async () => {
    while (queue.length) {
      const source = queue.shift();
      results.push(await collectSource(source, {
        ...options,
        previous: previousBySource[source.id] || {},
      }));
    }
  });
  await Promise.all(workers);
  return results.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}
