import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { mediaBySlug } from './registry.mjs';
import { publicationDecision } from './qa.mjs';
import { SitePublisher } from './site-publisher.mjs';
import { readJson, writeJsonAtomic } from './state-store.mjs';

const ROUTES = Object.freeze({
  news: 'actualites',
  video: 'videos',
  guide: 'guides',
});

function execute(command, args, { cwd, timeoutMs = 900_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timeout après ${timeoutMs} ms`));
    }, timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise({ code, stdout, stderr });
      else reject(new Error(`${command} exit ${code}: ${(stderr || stdout).slice(-2_000)}`));
    });
  });
}

function boolean(value) {
  return /^(?:1|true|yes)$/i.test(String(value || ''));
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function dayKey(value, timeZone = 'Europe/Paris') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value instanceof Date ? value : new Date(value));
  const field = (type) => parts.find((part) => part.type === type)?.value;
  return `${field('year')}-${field('month')}-${field('day')}`;
}

function shadowDays(startedAt, now = new Date()) {
  const start = Date.parse(startedAt || '');
  return Number.isFinite(start) ? Math.max(0, Math.floor((now.getTime() - start) / 86_400_000)) : 0;
}

function assertSiteConfig(config, mediaSlug) {
  if (!config?.repository || !/^(?:git@|ssh:\/\/|https:\/\/)/.test(config.repository)) {
    throw new Error(`Dépôt Git absent ou invalide pour ${mediaSlug}`);
  }
  if (!config.branch) throw new Error(`Branche absente pour ${mediaSlug}`);
  return config;
}

export function siteConfigsFromPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  return Object.fromEntries(Object.entries(payload).map(([slug, value]) => [slug, {
    repository: value.repository,
    branch: value.branch || 'main',
    routeByContentType: value.routeByContentType || {},
  }]));
}

export function publicUrlForDraft(media, draft, siteConfig = {}) {
  const route = siteConfig.routeByContentType?.[draft.contentType] || ROUTES[draft.contentType];
  if (!route) throw new Error(`Route publique inconnue pour ${draft.contentType}`);
  return new URL(`${String(route).replace(/^\/+|\/+$/g, '')}/${draft.slug}`, `${media.siteUrl}/`).toString();
}

export class PublicationWorker {
  constructor({
    store,
    siteConfigs = {},
    executeImpl = execute,
    fetchImpl = fetch,
    env = process.env,
    now = () => new Date(),
  } = {}) {
    if (!store) throw new Error('MediaStateStore requis');
    this.store = store;
    this.siteConfigs = siteConfigs;
    this.executeImpl = executeImpl;
    this.fetchImpl = fetchImpl;
    this.env = env;
    this.now = now;
  }

  decisionFor(draft) {
    const media = mediaBySlug(draft.mediaSlug);
    const decision = publicationDecision({
      draft,
      qa: draft.qa,
      media,
      publicationMode: this.env.MEDIA_ENGINE_PUBLICATION_MODE || 'draft',
      explicitApproval: boolean(this.env.MEDIA_ENGINE_AUTOMATIC_PUBLICATION_APPROVED),
      shadowDays: shadowDays(this.env.MEDIA_ENGINE_SHADOW_STARTED_AT, this.now()),
      shadowDaysRequired: Number(this.env.MEDIA_ENGINE_SHADOW_DAYS_REQUIRED || 7),
      now: this.now(),
    });
    if (!boolean(this.env.MEDIA_ENGINE_PUSH_ENABLED)) decision.blockers.push('git-push-disabled');
    const cutoverAt = Date.parse(this.env.MEDIA_ENGINE_AUTOMATIC_CUTOVER_AT || '');
    const generatedAt = Date.parse(draft.generatedAt || '');
    if (draft.contentType === 'video'
      && Number.isFinite(cutoverAt)
      && (!Number.isFinite(generatedAt) || generatedAt < cutoverAt)) {
      decision.blockers.push('historical-video-before-automatic-cutover');
    }
    const newsMaxAgeHours = positiveInteger(this.env.MEDIA_ENGINE_NEWS_MAX_AGE_HOURS, 72);
    if (draft.contentType === 'news'
      && Number.isFinite(generatedAt)
      && this.now().getTime() - generatedAt > newsMaxAgeHours * 3_600_000) {
      decision.blockers.push(`stale-news-over-${newsMaxAgeHours}-hours`);
    }
    decision.allowed = decision.blockers.length === 0;
    decision.action = decision.allowed ? 'publish' : 'keep-draft';
    return decision;
  }

  publicationReceipts() {
    const events = this.store.read('events', { events: {} }).events || {};
    return Object.entries(events)
      .filter(([key, receipt]) => key.startsWith('published:') && receipt?.publishedAt)
      .map(([, receipt]) => receipt)
      .filter((receipt) => Number.isFinite(Date.parse(receipt.publishedAt)));
  }

  queueBlockersFor(draft, receipts = this.publicationReceipts()) {
    const blockers = [];
    const now = this.now();
    const today = dayKey(now);
    const todayReceipts = receipts.filter((receipt) => dayKey(receipt.publishedAt) === today);
    const dailyLimit = positiveInteger(this.env.MEDIA_ENGINE_PUBLICATION_DAILY_LIMIT, 6);
    const perMediaLimit = positiveInteger(this.env.MEDIA_ENGINE_PUBLICATION_PER_MEDIA_DAILY_LIMIT, 1);
    const minIntervalMinutes = positiveInteger(this.env.MEDIA_ENGINE_PUBLICATION_MIN_INTERVAL_MINUTES, 90);
    if (todayReceipts.length >= dailyLimit) blockers.push(`network-daily-limit-${dailyLimit}`);
    if (todayReceipts.filter((receipt) => receipt.mediaSlug === draft.mediaSlug).length >= perMediaLimit) {
      blockers.push(`media-daily-limit-${draft.mediaSlug}-${perMediaLimit}`);
    }
    const lastPublishedAt = receipts.reduce((latest, receipt) => Math.max(latest, Date.parse(receipt.publishedAt) || 0), 0);
    const nextAllowedAt = lastPublishedAt + minIntervalMinutes * 60_000;
    if (lastPublishedAt && nextAllowedAt > now.getTime()) {
      blockers.push(`network-cooldown-until-${new Date(nextAllowedAt).toISOString()}`);
    }
    return blockers;
  }

  async verifyLive(url, title, { attempts = 12, intervalMs = 15_000 } = {}) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, {
          headers: { 'user-agent': 'AlexandreMediaEngine/0.3 live-verifier' },
          redirect: 'follow',
          signal: AbortSignal.timeout(20_000),
        });
        const body = response.ok ? await response.text() : '';
        if (response.ok && (!title || body.includes(title))) {
          return { verified: true, status: response.status, attempt, observedAt: this.now().toISOString() };
        }
        lastError = `HTTP ${response.status}${response.ok ? ', titre absent' : ''}`;
      } catch (error) {
        lastError = String(error?.message || error);
      }
      if (attempt < attempts) await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
    }
    return { verified: false, error: lastError, observedAt: this.now().toISOString() };
  }

  async publishDraftPath(draftPath, { dryRun = false, verifyLive = true } = {}) {
    const absoluteDraftPath = resolve(draftPath);
    if (!existsSync(absoluteDraftPath)) throw new Error(`Brouillon introuvable: ${absoluteDraftPath}`);
    const draft = readJson(absoluteDraftPath, null);
    if (!draft) throw new Error(`Brouillon JSON invalide: ${absoluteDraftPath}`);
    const media = mediaBySlug(draft.mediaSlug);
    if (!media) throw new Error(`Média inconnu dans le brouillon: ${draft.mediaSlug}`);
    const siteConfig = assertSiteConfig(this.siteConfigs[media.slug], media.slug);
    const decision = this.decisionFor(draft);
    const publicUrl = publicUrlForDraft(media, draft, siteConfig);
    if (dryRun || !decision.allowed) return { dryRun, allowed: decision.allowed, decision, publicUrl, draftPath: absoluteDraftPath };

    const workspaceRoot = mkdtempSync(join(tmpdir(), `alexandre-media-${media.slug}-`));
    const repoPath = join(workspaceRoot, 'site');
    let pushed = false;
    try {
      await this.executeImpl(this.env.GIT_BIN || '/usr/bin/git', [
        'clone', '--depth', '1', '--single-branch', '--branch', siteConfig.branch,
        siteConfig.repository, repoPath,
      ], { timeoutMs: 600_000 });
      const publisher = new SitePublisher({ repoPath, media, executeImpl: this.executeImpl });
      const staged = publisher.stageDraft(draft);
      await publisher.verifyBuild();
      publisher.auditOutboundLinks(staged.destination, draft);
      publisher.activateDraft(staged.destination, decision);
      await publisher.verifyBuild();
      publisher.auditOutboundLinks(staged.destination, draft);

      const relativeContent = staged.destination.slice(repoPath.length + 1);
      const relativeAsset = staged.publicAssetPath.slice(repoPath.length + 1);
      await this.executeImpl(this.env.GIT_BIN || '/usr/bin/git', ['add', '--', relativeContent, relativeAsset], { cwd: repoPath });
      const stagedDiff = await this.executeImpl(this.env.GIT_BIN || '/usr/bin/git', ['diff', '--cached', '--name-only'], { cwd: repoPath });
      const stagedPaths = stagedDiff.stdout.trim().split('\n').filter(Boolean).sort();
      const expectedPaths = [relativeContent, relativeAsset].sort();
      if (JSON.stringify(stagedPaths) !== JSON.stringify(expectedPaths)) {
        throw new Error(`Périmètre Git inattendu: ${stagedPaths.join(', ')}`);
      }
      await this.executeImpl(this.env.GIT_BIN || '/usr/bin/git', [
        '-c', 'user.name=Hermes Media Engine',
        '-c', 'user.email=hermes@alexandrechaimbault.com',
        'commit', '-m', `content(${media.slug}): ${draft.contentType} ${draft.slug}`,
      ], { cwd: repoPath });
      const commit = (await this.executeImpl(this.env.GIT_BIN || '/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: repoPath })).stdout.trim();
      await this.executeImpl(this.env.GIT_BIN || '/usr/bin/git', ['push', 'origin', `HEAD:${siteConfig.branch}`], {
        cwd: repoPath,
        timeoutMs: 600_000,
      });
      pushed = true;
      const live = verifyLive ? await this.verifyLive(publicUrl, draft.title) : { verified: null, reason: 'verification-disabled' };
      const receipt = {
        version: 1,
        status: live.verified === false ? 'pushed-unverified' : 'published',
        publishedAt: this.now().toISOString(),
        mediaSlug: media.slug,
        contentType: draft.contentType,
        slug: draft.slug,
        draftPath: absoluteDraftPath,
        publicUrl,
        repository: siteConfig.repository,
        branch: siteConfig.branch,
        commit,
        live,
      };
      const receiptPath = join(this.store.stateDir, 'publication-receipts', media.slug, `${draft.slug}.json`);
      writeJsonAtomic(receiptPath, receipt);
      this.store.markEvent(`published:${media.slug}:${draft.contentType}:${draft.slug}`, receipt);
      this.store.enqueue('events', `published-${media.slug}-${draft.contentType}-${draft.slug}`, {
        type: live.verified ? 'editorial.article.published' : 'editorial.article.pushed-unverified',
        createdAt: this.now().toISOString(),
        ...receipt,
        bannerPath: draft.banner?.path || null,
        title: draft.title,
      });
      return { ...receipt, receiptPath };
    } catch (error) {
      const failure = {
        version: 1,
        type: pushed ? 'editorial.article.pushed-unverified' : 'editorial.publication.failed',
        createdAt: this.now().toISOString(),
        mediaSlug: media.slug,
        draftPath: absoluteDraftPath,
        publicUrl,
        pushed,
        error: String(error?.message || error),
      };
      this.store.enqueue('events', `publication-failed-${media.slug}-${draft.contentType}-${draft.slug}`, failure);
      throw error;
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  }

  async run({ mediaSlug = null, dryRun = false, limit = 1 } = {}) {
    const paths = this.store.listDraftPaths(mediaSlug);
    const results = [];
    const held = [];
    const receipts = this.publicationReceipts();
    const queue = paths
      .map((path) => ({ path, draft: readJson(path, null) }))
      .filter((entry) => entry.draft)
      .sort((left, right) => {
        const leftAt = Date.parse(left.draft.scheduledPublishAt || left.draft.generatedAt || 0) || 0;
        const rightAt = Date.parse(right.draft.scheduledPublishAt || right.draft.generatedAt || 0) || 0;
        return leftAt - rightAt || left.path.localeCompare(right.path);
      });
    for (const { path, draft } of queue) {
      if (results.length >= limit) break;
      if (!draft?.qa?.passed) continue;
      if (draft?.publicationEligibility?.status !== 'eligible') continue;
      if (this.store.hasEvent(`published:${draft.mediaSlug}:${draft.contentType}:${draft.slug}`)) continue;
      const decision = this.decisionFor(draft);
      const blockers = [...decision.blockers, ...this.queueBlockersFor(draft, receipts)];
      if (blockers.length) {
        held.push({ draftPath: path, mediaSlug: draft.mediaSlug, contentType: draft.contentType, blockers });
        continue;
      }
      const published = await this.publishDraftPath(path, { dryRun });
      results.push(published);
      if (!dryRun && published?.publishedAt) receipts.push(published);
    }
    return { inspected: paths.length, heldCount: held.length, held: held.slice(0, 25), results };
  }
}

export function defaultSiteConfigsPath(env = process.env) {
  return env.MEDIA_ENGINE_SITES_PATH || '/etc/alexandre-media-engine/sites.json';
}

export function loadSiteConfigs(path = defaultSiteConfigsPath()) {
  return siteConfigsFromPayload(readJson(path, {}));
}
