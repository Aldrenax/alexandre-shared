/**
 * YouTube channel feed + video info helpers (Innertube + RSS).
 *
 * Portable shared lib — pas de dépendance à channel.config.mjs.
 * Chaque site appelle avec son propre channelId.
 *
 * Anti-bot YouTube : si .youtube-cookies.txt existe au cwd du process, il
 * sera passé automatiquement à yt-dlp via whisper.mjs (voir cette lib).
 */
import { Innertube } from 'youtubei.js';
import RssParser from 'rss-parser';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function parseRelativeDate(text, now = new Date()) {
  if (!text || typeof text !== 'string') return null;
  const t = text.toLowerCase().trim();
  const frMatch = t.match(/il y a (un|une|\d+)\s+(seconde|minute|heure|jour|semaine|mois|an|ann[ée]e)s?/);
  const enMatch = t.match(/(an?|\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/);
  const m = frMatch || enMatch;
  if (!m) {
    if (t.includes('hier') || t.includes('yesterday')) return new Date(now.getTime() - 24 * 3600 * 1000);
    if (t.includes("aujourd'hui") || t.includes('today')) return now;
    return null;
  }
  const n = ['un', 'une', 'a', 'an'].includes(m[1]) ? 1 : parseInt(m[1], 10);
  const unit = m[2];
  const ms = (() => {
    if (/seconde|second/.test(unit)) return n * 1000;
    if (/minute/.test(unit)) return n * 60 * 1000;
    if (/heure|hour/.test(unit)) return n * 3600 * 1000;
    if (/jour|day/.test(unit)) return n * 24 * 3600 * 1000;
    if (/semaine|week/.test(unit)) return n * 7 * 24 * 3600 * 1000;
    if (/mois|month/.test(unit)) return n * 30.44 * 24 * 3600 * 1000;
    if (/an|year/.test(unit)) return n * 365.25 * 24 * 3600 * 1000;
    return 0;
  })();
  return new Date(now.getTime() - ms);
}

export function extractPublishedAt(info, basic) {
  if (basic?.publish_date) {
    const d = new Date(basic.publish_date);
    if (!isNaN(d.getTime())) return d;
  }
  const publishedText = info?.primary_info?.published?.text;
  if (publishedText) {
    const d = parseRelativeDate(publishedText);
    if (d) return d;
  }
  if (basic?.start_timestamp) {
    const d = new Date(basic.start_timestamp);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}


let _yt = null;
async function yt() {
  if (!_yt) _yt = await Innertube.create({ lang: 'fr', location: 'FR', retrieve_player: false });
  return _yt;
}

/**
 * Fetch a YouTube channel RSS feed (latest ~15 videos).
 * @param {string} channelId - required, e.g. "UC..."
 * @param {object} [opts]
 * @param {string} [opts.userAgent] - fallback UA if browser-UA gets 4xx (cloud egress IPs)
 */
function ytDlpDate(entry = {}) {
  if (Number.isFinite(Number(entry.timestamp))) return new Date(Number(entry.timestamp) * 1_000);
  const raw = String(entry.upload_date || '');
  if (/^\d{8}$/.test(raw)) return new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T12:00:00.000Z`);
  return new Date();
}

/**
 * Fallback quand le flux RSS YouTube est indisponible. yt-dlp est déjà utilisé
 * par le moteur pour les métadonnées et les transcriptions : il n'ajoute donc
 * ni compte ni dépendance externe. Une chaîne sans vidéo publique retourne une
 * liste vide, ce qui est un état sain et non une erreur de cycle.
 */
export async function getChannelFeedWithYtDlp(channelId, {
  execFileImpl = execFileAsync,
  env = process.env,
} = {}) {
  const url = `https://www.youtube.com/channel/${channelId}/videos`;
  let stdout = '';
  try {
    ({ stdout = '' } = await execFileImpl('yt-dlp', [
      '--flat-playlist',
      '--playlist-end', '15',
      '--dump-single-json',
      '--no-warnings',
      '--ignore-no-formats',
      url,
    ], {
      encoding: 'utf8',
      timeout: 45_000,
      maxBuffer: 4 * 1024 * 1024,
      env,
    }));
  } catch (error) {
    // Une chaîne peut volontairement ne pas exposer d'onglet Vidéos. C'est
    // l'équivalent d'un flux vide, pas une panne de la chaîne ou du moteur.
    if (/does not have a videos tab|no videos/i.test(String(error?.stderr || error?.message || error))) return [];
    throw error;
  }
  if (!String(stdout).trim()) return [];
  const payload = JSON.parse(stdout);
  const entries = Array.isArray(payload.entries) ? payload.entries : [payload];
  return entries
    .filter((entry) => entry?.id)
    .map((entry) => ({
      videoId: String(entry.id),
      title: entry.title || '',
      link: entry.webpage_url || `https://www.youtube.com/watch?v=${entry.id}`,
      pubDate: ytDlpDate(entry),
      summary: entry.description || '',
      source: 'yt-dlp-fallback',
    }));
}

export async function getChannelFeed(channelId, opts = {}) {
  if (!channelId) throw new Error('channelId required (e.g. "UC...")');
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  // YouTube's feed endpoint occasionally serves 4xx to non-browser UAs on cloud
  // egress IPs (GitHub Actions runners, Hetzner). Try with a browser UA first,
  // fall back to a custom UA if provided.
  const fetchImpl = opts.fetchImpl || fetch;
  const fetchWith = (ua) =>
    fetchImpl(url, {
      headers: {
        'User-Agent': ua,
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        Accept: 'application/rss+xml, application/xml, text/xml, */*;q=0.5',
      },
    });
  let res = await fetchWith(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  );
  if (!res.ok) res = await fetchWith(opts.userAgent || 'alexandre-network-bot/1.0');
  if (!res.ok) {
    const fallback = opts.ytDlpFeedImpl || getChannelFeedWithYtDlp;
    try {
      return await fallback(channelId, opts);
    } catch (fallbackError) {
      throw new Error(`Channel feed unavailable: RSS ${res.status} for ${channelId}; yt-dlp fallback: ${String(fallbackError?.message || fallbackError)}`);
    }
  }
  const text = await res.text();
  const parser = new RssParser({
    customFields: { item: [['yt:videoId', 'videoId'], ['media:group', 'media']] },
    timeout: 15000,
  });
  const feed = await parser.parseString(text);
  return feed.items.map((it) => ({
    videoId: it.videoId || (it.link?.split('=').pop() ?? ''),
    title: it.title ?? '',
    link: it.link ?? '',
    pubDate: it.isoDate ? new Date(it.isoDate) : new Date(),
    summary: it.contentSnippet || '',
  }));
}

export function youtubeThumbnailCandidates(videoId, thumbnails = []) {
  const observed = (Array.isArray(thumbnails) ? thumbnails : [])
    .filter((thumbnail) => thumbnail?.url)
    .map((thumbnail) => ({ ...thumbnail, source: thumbnail.source || 'youtube-metadata' }))
    .sort((left, right) => Number(right.width || 0) - Number(left.width || 0));
  const deterministic = videoId ? [
    { url: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`, width: 1_280, height: 720, source: 'youtube-cdn-fallback' },
    { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, width: 480, height: 360, source: 'youtube-cdn-fallback' },
    { url: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`, width: 320, height: 180, source: 'youtube-cdn-fallback' },
    { url: `https://i.ytimg.com/vi/${videoId}/default.jpg`, width: 120, height: 90, source: 'youtube-cdn-fallback' },
  ] : [];
  const seen = new Set();
  return [...observed, ...deterministic].filter((thumbnail) => {
    if (seen.has(thumbnail.url)) return false;
    seen.add(thumbnail.url);
    return true;
  });
}

export function resolveVideoMetadata(basic = {}, fallback = {}, videoId = '') {
  const fallbackThumbnails = Array.isArray(fallback.thumbnails)
    ? fallback.thumbnails.filter((thumbnail) => thumbnail?.url)
    : fallback.thumbnail
      ? [{ url: fallback.thumbnail, width: fallback.width, height: fallback.height }]
      : [];
  const basicThumbnails = Array.isArray(basic.thumbnail)
    ? basic.thumbnail.filter((thumbnail) => thumbnail?.url)
    : [];
  const observedThumbnails = fallbackThumbnails.length ? fallbackThumbnails : basicThumbnails;
  const thumbnails = youtubeThumbnailCandidates(videoId, observedThumbnails);
  const duration = Number(fallback.duration || basic.duration || 0);
  const thumb = thumbnails[0] || null;
  const isVerticalThumb = Boolean(thumb && thumb.height && thumb.width && thumb.height > thumb.width);
  const isShortDuration = duration > 0 && duration < 60;
  const isShortUrl = String(fallback.webpage_url || fallback.original_url || '').includes('/shorts/');
  return {
    duration,
    thumbnails,
    isShort: Boolean(basic.is_short) || isShortDuration || isVerticalThumb || isShortUrl,
  };
}

export async function getVideoInfo(videoId) {
  const client = await yt();
  const info = await client.getInfo(videoId);
  const basic = info.basic_info ?? {};
  let fallback = {};
  if (!basic.is_short) {
    try {
      const { ytDlpVideoMetadata } = await import('./whisper.mjs');
      fallback = await ytDlpVideoMetadata(videoId);
    } catch {
      /* yt-dlp metadata is best-effort */
    }
  }
  // Détection Shorts multi-signaux (le flag is_short seul retourne souvent
  // false sur des Shorts évidents). On combine :
  //   1. basic.is_short (signal officiel, parfois manquant)
  //   2. durée < 60s (cap officiel des Shorts pour la plupart des comptes)
  //   3. thumbnail vertical (Shorts = 9:16, vidéos = 16:9)
  // Si un seul signal positif, on traite comme Short.
  const { duration, thumbnails, isShort } = resolveVideoMetadata(basic, fallback, videoId);

  // Transcript: try Innertube first, fallback to Whisper if missing/empty.
  // Shorts are never article-worthy → skip transcription entirely (saves
  // Whisper CPU + yt-dlp download).
  let transcriptText = '';
  let transcriptSource = 'none';
  let chapters = [];
  if (!isShort) {
    try {
      const { readCachedTranscript } = await import('./whisper.mjs');
      transcriptText = readCachedTranscript(videoId);
      if (transcriptText.length >= 500) transcriptSource = 'cache';
    } catch {
      /* local transcript cache unavailable */
    }
  }
  if (!isShort && transcriptText.length < 200) {
    try {
      const transcriptInfo = await info.getTranscript();
      const segments =
        transcriptInfo?.transcript?.content?.body?.initial_segments ?? [];
      transcriptText = segments
        .map((s) => (s?.snippet?.text ?? '').trim())
        .filter(Boolean)
        .join(' ');
      if (transcriptText.length > 200) transcriptSource = 'youtube';
    } catch (e) {
      /* transcript unavailable from YouTube */
    }
  }

  // Fallback to local faster-whisper if YouTube transcript is missing/short.
  // No API key needed (CPU-only, free). Gracefully degrades if binaries missing.
  if (!isShort && transcriptText.length < 200) {
    try {
      const { whisperTranscribe, checkWhisperReady } = await import('./whisper.mjs');
      const ready = await checkWhisperReady();
      const missing = Object.entries(ready).filter(([, v]) => !v).map(([k]) => k);
      if (missing.length === 0) {
        console.log(`  → Falling back to local faster-whisper for ${videoId}…`);
        transcriptText = await whisperTranscribe(videoId, { language: 'fr' });
        if (transcriptText.length > 200) transcriptSource = 'whisper';
      } else {
        console.warn(`  · Whisper unavailable (missing: ${missing.join(', ')}). Skipping ${videoId}.`);
      }
    } catch (e) {
      console.warn(`  ! Whisper fallback failed: ${e.message}`);
    }
  }

  // Chapters from description (best-effort)
  const primaryTitle = info.primary_info?.title?.text ?? '';
  const secondaryDescription = info.secondary_info?.description?.text ?? '';
  const description = basic.short_description || secondaryDescription || fallback.description || '';
  const lines = description.split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s+[—–\-:•]?\s*(.+?)\s*$/);
    if (m) {
      const h = m[1] ? parseInt(m[1], 10) : 0;
      const mm = parseInt(m[2], 10);
      const ss = parseInt(m[3], 10);
      const seconds = h * 3600 + mm * 60 + ss;
      const title = m[4].trim();
      if (title && title.length < 120) chapters.push({ timestamp: seconds, title });
    }
  }

  // Affiliate link extraction (first URL in first 5 description lines)
  let affiliateUrl;
  let affiliateLabel;
  const urlRe = /https?:\/\/[^\s)]+/g;
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const m = lines[i].match(urlRe);
    if (m && m[0]) {
      affiliateUrl = m[0].replace(/[)>.,;]+$/, '');
      affiliateLabel = lines[i].split(/[:\-—]/)[0].trim().slice(0, 60) || 'Lien recommandé';
      break;
    }
  }

  return {
    videoId,
    title: basic.title || primaryTitle || fallback.title || '',
    description,
    channel: basic.channel?.name || fallback.channel || fallback.uploader || '',
    duration, // seconds
    thumbnails,
    publishedAt: extractPublishedAt(info, basic),
    publishedText: info.primary_info?.published?.text ?? null,
    isLive: Boolean(basic.is_live ?? false),
    isShort,
    transcriptText,
    transcriptSource,
    chapters,
    affiliateUrl,
    affiliateLabel,
  };
}

export function formatDurationISO(seconds) {
  if (!seconds) return undefined;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  let out = 'PT';
  if (h) out += `${h}H`;
  if (m) out += `${m}M`;
  if (s) out += `${s}S`;
  return out === 'PT' ? 'PT0S' : out;
}

export function formatDurationHuman(seconds) {
  if (!seconds) return undefined;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')} min`;
}
