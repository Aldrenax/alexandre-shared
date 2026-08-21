#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { MediaEngine } from '../media/engine.mjs';
import { loadEnvironmentFile } from '../media/environment.mjs';
import { applyDraftCuration, curateDraftQueue } from '../media/draft-curation.mjs';
import { loadSiteConfigs, PublicationWorker } from '../media/publication-worker.mjs';
import { runPreflight } from '../media/preflight.mjs';
import { registrySnapshot, validateRegistry } from '../media/registry.mjs';
import { classifyRunOutcome } from '../media/run-outcome.mjs';
import { WordPressDraftPublisher } from '../media/wordpress-draft-publisher.mjs';

// Les commandes opérateur et les heartbeats appellent aussi le CLI hors
// systemd. Charger les mêmes fichiers garantit un préflight fidèle, notamment
// pour le compteur shadow, sans dupliquer les valeurs dans plusieurs fichiers.
loadEnvironmentFile(process.env.MEDIA_ENGINE_ENV_FILE || '/etc/alexandre-media-engine/media-engine.env');
loadEnvironmentFile(process.env.MEDIA_ENGINE_SHADOW_ENV_FILE || '/etc/alexandre-media-engine/shadow.env');
loadEnvironmentFile(
  process.env.MEDIA_ENGINE_PUBLICATION_ENV_FILE || '/etc/alexandre-media-engine/publication.env',
  process.env,
  { override: true },
);

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function readJson(path, fallback) {
  if (!path || !existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function offersFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.offers)) return payload.offers;
  if (Array.isArray(payload?.programs)) return payload.programs;
  return [];
}

const command = process.argv[2] || 'validate';
const dryRun = process.argv.includes('--dry-run');
const apply = process.argv.includes('--apply');
const mediaSlug = argument('--media');
const jsonOutput = process.argv.includes('--json');
const offers = offersFromPayload(readJson(process.env.MEDIA_ENGINE_OFFERS_PATH, []));
const internalLinks = readJson(process.env.MEDIA_ENGINE_INTERNAL_LINKS_PATH, {});
const guideOpportunities = readJson(process.env.MEDIA_ENGINE_GUIDE_OPPORTUNITIES_PATH, []);
const engine = new MediaEngine({ offers, internalLinks });

function output(value) {
  if (jsonOutput) console.log(JSON.stringify(value));
  else console.log(JSON.stringify(value, null, 2));
}

let result;
try {
  if (command === 'validate') {
    const errors = validateRegistry();
    output({ valid: errors.length === 0, errors, registry: registrySnapshot() });
    if (errors.length) process.exitCode = 1;
  } else if (command === 'preflight') {
    result = await runPreflight({ hermes: engine.hermes, runtimeHealth: engine.healthReport() });
    output(result);
    if (!result.readyForShadow) process.exitCode = 1;
  } else if (command === 'collect') {
    result = await engine.collect({ mediaSlug, dryRun });
    output(result);
  } else if (command === 'research') {
    result = await engine.researchX({
      mediaSlug,
      dryRun,
      fromDate: argument('--from', ''),
      toDate: argument('--to', ''),
    });
    output(result);
  } else if (command === 'health') {
    result = engine.healthReport();
    output(result);
  } else if (command === 'monitor') {
    result = engine.monitor({ dryRun });
    output(result);
  } else if (command === 'video') {
    result = await engine.runVideoCycle({ mediaSlug, dryRun });
    output(result);
  } else if (command === 'guide') {
    result = await engine.runGuideCycle({ mediaSlug, opportunities: guideOpportunities, dryRun });
    output(result);
  } else if (command === 'curate') {
    const entries = engine.store.listDrafts(mediaSlug);
    result = curateDraftQueue(entries, internalLinks, {
      automaticCutoverAt: argument('--cutover-at'),
      newsMaxAgeHours: Number(argument('--news-max-age-hours', process.env.MEDIA_ENGINE_NEWS_MAX_AGE_HOURS || '72')),
    });
    if (apply) applyDraftCuration(entries, result);
    result = { ...result, applied: apply };
    output(result);
  } else if (command === 'publish') {
    const worker = new PublicationWorker({ store: engine.store, siteConfigs: loadSiteConfigs() });
    const draftPath = argument('--draft');
    result = draftPath
      ? await worker.publishDraftPath(draftPath, { dryRun })
      : await worker.run({ mediaSlug, dryRun, limit: Number(argument('--limit', '1')) });
    output(result);
  } else if (command === 'wordpress-shadow') {
    const publisher = new WordPressDraftPublisher({ store: engine.store });
    const draftPath = argument('--draft');
    result = draftPath
      ? await publisher.mirrorDraftPath(draftPath, { dryRun })
      : await publisher.run({ dryRun, limit: Number(argument('--limit', '1')) });
    output(result);
  } else if (command === 'run') {
    result = await engine.runCycle({ mediaSlug, dryRun });
    output(result);
  } else {
    console.error('Usage: alexandre-media-engine <validate|preflight|collect|research|video|guide|curate|publish|wordpress-shadow|health|monitor|run> [--media slug] [--draft path] [--limit n] [--dry-run] [--apply] [--json]');
    process.exitCode = 2;
  }
  if (!dryRun && result !== undefined && !result?.skipped && ['collect', 'research', 'video', 'guide', 'curate', 'publish', 'wordpress-shadow', 'run'].includes(command)) {
    engine.store.initialize();
    const outcome = classifyRunOutcome(command, result, { mediaSlug: mediaSlug || null });
    engine.store.recordRun(command, outcome.receipt);
    if (outcome.failed) process.exitCode = 1;
  }
} catch (error) {
  if (!dryRun) {
    try {
      engine.store.initialize();
      engine.store.recordRun(command, { status: 'failed', mediaSlug: mediaSlug || null, error: String(error?.message || error) });
      const bucket = new Date().toISOString().slice(0, 13);
      engine.store.enqueue('events', `engine-failed-${command}-${bucket}`, {
        version: 1,
        eventId: `engine-failed-${command}-${bucket}`,
        type: 'editorial.engine.degraded',
        createdAt: new Date().toISOString(),
        mediaSlug: mediaSlug || 'chaimbault',
        command,
        error: String(error?.message || error),
      });
    } catch {}
  }
  output({ ok: false, error: String(error?.message || error) });
  process.exitCode = 1;
}
