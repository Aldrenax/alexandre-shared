#!/usr/bin/env node

import { basename, dirname, join } from 'node:path';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { MediaEngine, materializeBanner } from '../media/engine.mjs';
import { ARTICLE_THUMBNAIL_POLICY, buildBannerPrompt } from '../media/editorial.mjs';
import { loadEnvironmentFile } from '../media/environment.mjs';
import { mediaBySlug } from '../media/registry.mjs';
import { writeJsonAtomic } from '../media/state-store.mjs';
import { representativeThumbnailBatch } from '../media/thumbnail-refresh.mjs';

loadEnvironmentFile(process.env.MEDIA_ENGINE_ENV_FILE || '/etc/alexandre-media-engine/media-engine.env');

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const apply = process.argv.includes('--apply');
const all = process.argv.includes('--all');
const newsOnly = process.argv.includes('--news-only');
const mediaSlug = argument('--media');
const limit = positiveInteger(argument('--limit'), all ? Number.MAX_SAFE_INTEGER : 6);
const engine = new MediaEngine();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const entries = engine.store.listDrafts(mediaSlug)
  .filter(({ draft }) => draft?.thumbnailRefresh?.policy !== ARTICLE_THUMBNAIL_POLICY)
  .filter(({ draft }) => !newsOnly || draft?.contentType === 'news');
const batch = representativeThumbnailBatch(entries, { limit, all });

const planned = batch.map(({ path, draft }) => ({
  mediaSlug: draft.mediaSlug,
  contentType: draft.contentType,
  title: draft.title,
  slug: draft.slug,
  draftPath: path,
}));

if (!apply) {
  console.log(JSON.stringify({ dryRun: true, selected: planned.length, planned }, null, 2));
  process.exit(0);
}

engine.store.initialize();
const results = [];
for (const { path: draftPath, draft: originalDraft } of batch) {
  const media = mediaBySlug(originalDraft.mediaSlug);
  if (!media) {
    results.push({ draftPath, status: 'skipped', reason: 'unknown-media' });
    continue;
  }
  try {
    const response = await engine.hermes.generateBannerJson(buildBannerPrompt({ media, draft: originalDraft }));
    const imageSource = response?.imageSource || response?.imageUrl || response?.image;
    if (!response?.success || !imageSource) throw new Error('Génération d’image Hermes invalide');

    const previousPath = String(originalDraft.banner?.path || '').trim();
    let backupPath = null;
    if (previousPath && existsSync(previousPath)) {
      backupPath = join(engine.store.runtimeDir, 'backups', 'thumbnail-refresh', stamp, originalDraft.mediaSlug, basename(previousPath));
      mkdirSync(dirname(backupPath), { recursive: true, mode: 0o750 });
      copyFileSync(previousPath, backupPath);
    }

    const bannerPath = join(engine.store.assetsDir, originalDraft.mediaSlug, `${originalDraft.slug}.webp`);
    await materializeBanner(imageSource, bannerPath);
    const refreshedAt = new Date().toISOString();
    const draft = {
      ...originalDraft,
      banner: {
        path: bannerPath,
        alt: response.alt || originalDraft.bannerBrief?.alt || originalDraft.title,
        width: 1280,
        height: 720,
        source: `hermes:image_gen:${ARTICLE_THUMBNAIL_POLICY}`,
      },
      thumbnailRefresh: {
        refreshedAt,
        backupPath,
        policy: ARTICLE_THUMBNAIL_POLICY,
        scope: 'local-draft-only',
      },
    };
    writeJsonAtomic(draftPath, draft);
    results.push({ mediaSlug: draft.mediaSlug, slug: draft.slug, status: 'refreshed', bannerPath, backupPath });
  } catch (error) {
    results.push({ mediaSlug: originalDraft.mediaSlug, slug: originalDraft.slug, status: 'failed', error: String(error?.message || error) });
  }
}

console.log(JSON.stringify({ dryRun: false, selected: planned.length, results }, null, 2));
if (results.some((result) => result.status === 'failed')) process.exitCode = 1;
