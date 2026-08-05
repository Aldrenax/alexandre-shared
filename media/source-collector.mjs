import { createHash } from 'node:crypto';

const USER_AGENT = 'AlexandreMediaEngine/0.3 (+https://alexandrechaimbault.com)';

function digest(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function decodeHtml(value = '') {
  return String(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
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
  for (const match of withoutBoilerplate(html).matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const title = decodeHtml(match[2]);
    if (title.length < 25 || title.length > 240) continue;
    let url;
    try { url = new URL(match[1], source.url); } catch { continue; }
    if (!/^https?:$/.test(url.protocol)) continue;
    if (url.hostname.replace(/^www\./, '') !== new URL(source.url).hostname.replace(/^www\./, '')) continue;
    url.hash = '';
    const key = url.toString();
    if (seen.has(key) || key === source.url) continue;
    seen.add(key);
    items.push({
      id: `${source.id}:${digest(key).slice(0, 16)}`,
      sourceId: source.id,
      sourceTier: source.tier,
      sourceOfficial: source.official,
      title,
      url: key,
      excerpt: '',
      publishedAt: null,
      author: source.name,
      media: source.media,
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
  return (feed.items || []).slice(0, 30).map((item) => ({
    id: item.guid || item.id || item.link || digest(item.title),
    sourceId: source.id,
    sourceTier: source.tier,
    sourceOfficial: source.official,
    title: decodeHtml(item.title),
    url: item.link || '',
    excerpt: decodeHtml(item.contentSnippet || item.summary || item.content || '').slice(0, 1_200),
    publishedAt: validDate(item.isoDate || item.pubDate),
    author: decodeHtml(item.creator || item.author || ''),
    media: source.media,
    kind: 'news',
  })).filter((item) => item.title && item.url);
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
  const publishedAt = validDate(
    html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)/i)?.[1]
      || html.match(/"datePublished"\s*:\s*"([^"]+)"/i)?.[1],
  );
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
      title,
      url: new URL(canonical, source.url).toString(),
      excerpt,
      publishedAt,
      author: source.name,
      media: source.media,
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
      const evidenceText = /application\/json/i.test(contentType)
        ? String(text).slice(0, 12_000)
        : extractBalancedEvidence(text, 12_000);
      if (evidenceText.length >= 200) {
        enriched = {
          ...enriched,
          excerpt: evidenceText,
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
  return {
    ...candidate,
    sources,
    evidenceAvailableCount: sources.filter((source) => source.evidenceStatus === 'available').length,
    evidenceEnrichedAt: new Date().toISOString(),
  };
}

function apiItems(payload, source) {
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
      title: decodeHtml(title),
      url: item.url || item.URL || source.url,
      excerpt: decodeHtml(excerpt).slice(0, 1_200),
      publishedAt: validDate(item.publishedAt || item.date || item.ReportReceivedDate),
      author: source.name,
      media: source.media,
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
  try {
    const response = await fetchSource(source, previous, fetchImpl, timeoutMs);
    if (response.status === 304) {
      return {
        sourceId: source.id,
        required: source.required !== false,
        status: 'healthy',
        notModified: true,
        checkedAt: startedAt,
        lastOkAt: startedAt,
        consecutiveFailures: 0,
        etag: previous.etag || null,
        lastModified: previous.lastModified || null,
        contentHash: previous.contentHash || null,
        items: [],
      };
    }
    if (!response.ok && !source.acceptedStatuses?.includes(response.status)) throw new Error(`HTTP ${response.status}`);

    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    let items = [];
    let contentHash = digest(text);
    if (source.type === 'rss') {
      items = await parseRss(text, source);
    } else if (source.type === 'api') {
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`réponse API non JSON (${contentType || 'content-type inconnu'})`);
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
      lastOkAt: startedAt,
      consecutiveFailures: 0,
      etag: response.headers.get('etag') || previous.etag || null,
      lastModified: response.headers.get('last-modified') || previous.lastModified || null,
      contentHash,
      finalUrl: response.url || source.url,
      contentType,
      items,
    };
  } catch (error) {
    const consecutiveFailures = Number(previous.consecutiveFailures || 0) + 1;
    return {
      sourceId: source.id,
      required: source.required !== false,
      status: consecutiveFailures >= 3 ? 'quarantined' : 'degraded',
      checkedAt: startedAt,
      lastOkAt: previous.lastOkAt || null,
      consecutiveFailures,
      etag: previous.etag || null,
      lastModified: previous.lastModified || null,
      contentHash: previous.contentHash || null,
      error: String(error?.message || error),
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
