import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const COLLECTIONS = Object.freeze({
  news: 'articles',
  video: 'videos',
  guide: 'guides',
});

function yamlValue(value) {
  if (value === undefined) return undefined;
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (Array.isArray(value) || typeof value === 'object') return JSON.stringify(value);
  return JSON.stringify(String(value));
}

function frontmatter(entries) {
  return Object.entries(entries)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${yamlValue(value)}`)
    .join('\n');
}

function choose(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizedComparableUrl(value) {
  try {
    const url = new URL(String(value));
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|gclid|fbclid|ref_src)$/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return null;
  }
}

export function extractHttpUrls(content) {
  return [...new Set(
    String(content || '')
      .match(/https?:\/\/[^\s<>"'\])}]+/g)
      ?.map((value) => value.replace(/[.,;:!?]+$/, '')) || [],
  )];
}

export function auditDraftOutboundLinks(content, draft, media) {
  const allowedExact = new Set([
    ...(draft.sourceUrls || []),
    ...(draft.sources || []).map((source) => source?.url),
    draft.offer?.url,
    draft.video?.url,
    draft.video?.thumbnailUrl,
  ].filter(Boolean).map(normalizedComparableUrl).filter(Boolean));
  const internalOrigin = new URL(media.siteUrl).origin;
  const allowedVideoHosts = new Set(['youtube.com', 'youtu.be', 'youtube-nocookie.com']);
  const unexpected = [];
  for (const raw of extractHttpUrls(content)) {
    const normalized = normalizedComparableUrl(raw);
    if (!normalized) continue;
    const url = new URL(normalized);
    const host = url.hostname.replace(/^www\./, '');
    if (url.origin === internalOrigin || allowedVideoHosts.has(host) || allowedExact.has(normalized)) continue;
    unexpected.push(raw);
  }
  return {
    passed: unexpected.length === 0,
    unexpected: [...new Set(unexpected)],
    inspected: extractHttpUrls(content).length,
  };
}

export function formatVideoDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remaining = Math.floor(seconds % 60);
  const clock = hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
    : `${minutes}:${String(remaining).padStart(2, '0')}`;
  return `${clock} min`;
}

export function renderMdxDraft(draft, media, { coverUrl, now = new Date() } = {}) {
  const base = {
    title: draft.title,
    description: draft.description,
    pubDate: now.toISOString(),
    scheduledPublishAt: draft.scheduledPublishAt,
    tags: draft.tags || [],
    coverUrl,
    coverAlt: draft.banner?.alt || draft.bannerBrief?.alt || draft.title,
    wordCount: draft.wordCount,
    featured: false,
    draft: true,
  };
  let data;
  if (draft.contentType === 'news') {
    data = {
      ...base,
      editorialType: 'actualites',
      category: choose(draft.category, media.newsCategories, 'actualite'),
      sourceUrls: draft.sourceUrls || [],
      keyPoints: draft.keyPoints || [],
      faq: draft.faq || [],
    };
  } else if (draft.contentType === 'guide') {
    data = {
      ...base,
      topic: choose(draft.topic || draft.category, media.guideTopics, media.guideTopics[0]),
      keyPoints: draft.keyPoints || [],
      readingTime: Math.max(1, Math.round(Number(draft.wordCount || 0) / 230)),
    };
  } else if (draft.contentType === 'video') {
    if (!draft.video?.videoId || !draft.video?.publishedAt) throw new Error('Contexte vidéo incomplet pour écrire le MDX');
    data = {
      ...base,
      youtubeId: draft.video.videoId,
      youtubeTitle: draft.video.title || draft.title,
      youtubePublishedAt: draft.video.publishedAt,
      duration: formatVideoDuration(draft.video.duration),
      chapters: draft.video.chapters || [],
      affiliateUrl: draft.offer?.url || undefined,
      affiliateLabel: draft.offer?.name || undefined,
      category: choose(draft.category, media.newsCategories, 'analyse'),
      faq: draft.faq || [],
      transcriptHash: draft.video.transcriptHash || undefined,
    };
  } else {
    throw new Error(`Type de contenu non publiable: ${draft.contentType}`);
  }
  return `---\n${frontmatter(data)}\n---\n\n${draft.body.trim()}\n`;
}

function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode: 0o640 });
  renameSync(temporary, path);
}

function run(command, args, { cwd, timeoutMs = 600_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timeout`));
    }, timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise({ code, stdout, stderr });
      else reject(new Error(`${command} exit ${code}: ${stderr.slice(-1_500)}`));
    });
  });
}

export class SitePublisher {
  constructor({ repoPath, media, executeImpl = run } = {}) {
    if (!repoPath || !media) throw new Error('repoPath et media sont requis');
    this.repoPath = resolve(repoPath);
    this.media = media;
    this.executeImpl = executeImpl;
  }

  stageDraft(draft) {
    const collection = COLLECTIONS[draft.contentType];
    if (!collection) throw new Error(`Collection inconnue pour ${draft.contentType}`);
    if (!draft.banner?.path || !existsSync(draft.banner.path)) throw new Error('Bannière locale obligatoire avant écriture du brouillon');
    const assetName = `${draft.slug}-${basename(draft.banner.path)}`;
    const publicAssetPath = join(this.repoPath, 'public', 'media-engine', assetName);
    mkdirSync(dirname(publicAssetPath), { recursive: true, mode: 0o750 });
    copyFileSync(draft.banner.path, publicAssetPath);
    const coverUrl = `${this.media.siteUrl}/media-engine/${assetName}`;
    const content = renderMdxDraft(draft, this.media, { coverUrl });
    const destination = join(this.repoPath, 'src', 'content', collection, `${draft.slug}.mdx`);
    if (existsSync(destination)) throw new Error(`Le contenu existe déjà: ${destination}`);
    writeAtomic(destination, content);
    return { destination, publicAssetPath, coverUrl, draft: true };
  }

  async prepareWorkspace() {
    return this.executeImpl(process.env.NPM_BIN || '/usr/bin/npm', ['ci', '--ignore-scripts'], {
      cwd: this.repoPath,
      timeoutMs: 900_000,
    });
  }

  async verifyBuild() {
    return this.executeImpl(process.env.NPM_BIN || '/usr/bin/npm', ['run', 'build'], {
      cwd: this.repoPath,
      timeoutMs: 900_000,
    });
  }

  auditOutboundLinks(path, draft) {
    const result = auditDraftOutboundLinks(readFileSync(resolve(path), 'utf8'), draft, this.media);
    if (!result.passed) {
      throw new Error(`Liens sortants non validés après build: ${result.unexpected.join(', ')}`);
    }
    return result;
  }

  activateDraft(path, decision) {
    if (!decision?.allowed) throw new Error(`Activation refusée: ${(decision?.blockers || ['décision absente']).join(', ')}`);
    const absolute = resolve(path);
    if (!absolute.startsWith(join(this.repoPath, 'src', 'content'))) throw new Error('Chemin de brouillon hors du dépôt');
    const content = readFileSync(absolute, 'utf8');
    if (!/^draft:\s*true\s*$/m.test(content)) throw new Error('Le fichier n’est pas un brouillon activable');
    writeAtomic(absolute, content.replace(/^draft:\s*true\s*$/m, 'draft: false'));
    return absolute;
  }
}
