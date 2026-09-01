import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';

import {
  MediaEngine,
  shouldGenerateDraftForEvent,
  videoDraftReceipt,
} from '../media/engine.mjs';
import { MediaStateStore } from '../media/state-store.mjs';
import { ThumbnailGenerationBudget } from '../media/thumbnail-generation.mjs';
import {
  generateThumbnailWithQa,
  thumbnailItemAttemptSnapshot,
} from '../media/thumbnail-generation.mjs';
import {
  reconcileThumbnailQueues,
  thumbnailAttemptLedgerKey,
  thumbnailRefreshQueueId,
} from '../media/thumbnail-refresh.mjs';

function articlePayload(sourceUrl) {
  const words = Array.from({ length: 1_220 }, (_, index) => `explication${index}`).join(' ');
  return {
    title: 'Copilot Customize devient disponible pour tous',
    slug: 'copilot-customize-devient-disponible-pour-tous',
    description: 'GitHub rend son espace de personnalisation accessible et précise les options proposées aux utilisateurs.',
    body: `Introduction avec [la source officielle](${sourceUrl}).\n\n## Ce qui change\n\n${words}`,
    category: 'actualite',
    tags: ['github', 'ia'],
    keyPoints: ['Annonce officielle GitHub'],
    faq: [],
    sourceUrls: [sourceUrl],
    claims: [{ statement: 'GitHub rend cette fonction disponible', sourceRefs: ['S1'] }],
    bannerBrief: {
      headline: 'COPILOT CUSTOMIZE',
      concept: 'Objet technique générique sur fond cyan',
      alt: 'Illustration de Copilot Customize',
    },
  };
}

function bannerResult(imageSource, { clipped = false } = {}) {
  return {
    success: true,
    imageSource,
    alt: 'Illustration de Copilot Customize',
    qa: {
      finalAssetCount: 1,
      observedText: 'COPILOT CUSTOMIZE',
      textExact: true,
      textClipped: clipped,
      mobileReadable: true,
      usesLogo: false,
      usesInterface: false,
      usesFace: false,
      assetSources: [],
      fakeLogo: false,
      fakeInterface: false,
      fakeFace: false,
    },
  };
}

function visualResult(inspection, { clipped = false } = {}) {
  return {
    method: 'hermes-vision',
    independent: true,
    success: true,
    sha256: inspection.sha256,
    observedText: 'COPILOT CUSTOMIZE',
    textExact: true,
    textClipped: clipped,
    mobileReadable: true,
    textBoundingBox: { left: 0.10, top: 0.20, right: 0.60, bottom: 0.55 },
    usesLogo: false,
    usesInterface: false,
    usesFace: false,
  };
}

async function articleImageBuffer() {
  const width = 1_280;
  const height = 720;
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = ((y * width) + x) * 3;
      if (x < 832) {
        data[offset] = 0x13;
        data[offset + 1] = 0x94;
        data[offset + 2] = 0xC7;
      } else {
        const gray = (x * 31 + y * 17) % 256;
        data[offset] = gray;
        data[offset + 1] = gray;
        data[offset + 2] = gray;
      }
    }
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
}

async function waitUntil(predicate, { timeoutMs = 10_000, intervalMs = 10 } = {}) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('Délai dépassé en attente des processus concurrents');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function childResult(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Processus budget terminé avec ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}

function childExit(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('circuit miniature multiprocessus: aucune réservation perdue et budget global jamais dépassé', async () => {
  const root = mkdtempSync(join(tmpdir(), 'thumbnail-circuit-concurrent-'));
  const workerPath = join(root, 'budget-worker.mjs');
  const gatePath = join(root, 'start.gate');
  const workerCount = 6;
  const attemptsPerWorker = 20;
  const maximumAttempts = 73;
  const stateStoreUrl = new URL('../media/state-store.mjs', import.meta.url).href;
  const budgetUrl = new URL('../media/thumbnail-generation.mjs', import.meta.url).href;
  writeFileSync(workerPath, `
    import { existsSync, writeFileSync } from 'node:fs';
    const [root, gatePath, readyPath, storeUrl, generationUrl] = process.argv.slice(2);
    const { MediaStateStore } = await import(storeUrl);
    const { ThumbnailGenerationBudget } = await import(generationUrl);
    const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
    const store = new MediaStateStore(root);
    const budget = new ThumbnailGenerationBudget({
      maximumAttempts: ${maximumAttempts},
      consecutiveFailureLimit: 10_000,
      failureRateWindow: 500,
      failureRateLimit: 1,
      stateStore: store,
    });
    writeFileSync(readyPath, 'ready');
    while (!existsSync(gatePath)) Atomics.wait(waitBuffer, 0, 0, 2);
    const reserved = [];
    for (let index = 0; index < ${attemptsPerWorker}; index += 1) {
      const permit = budget.startAttempt();
      if (permit.allowed) {
        reserved.push(permit.attempt);
        budget.record(true);
      }
    }
    process.stdout.write(JSON.stringify({ reserved }));
  `, { mode: 0o640 });

  const children = Array.from({ length: workerCount }, (_, index) => {
    const readyPath = join(root, `worker-${index}.ready`);
    const child = spawn(process.execPath, [
      workerPath,
      root,
      gatePath,
      readyPath,
      stateStoreUrl,
      budgetUrl,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    return { readyPath, result: childResult(child) };
  });
  await waitUntil(() => children.every(({ readyPath }) => existsSync(readyPath)));
  writeFileSync(gatePath, 'go', { mode: 0o640 });
  const results = await Promise.all(children.map(({ result }) => result));
  const reservations = results.flatMap(({ reserved }) => reserved).sort((left, right) => left - right);
  const store = new MediaStateStore(root);
  const state = store.read('thumbnail-generation-circuit', {});

  assert.equal(reservations.length, maximumAttempts);
  assert.deepEqual(reservations, Array.from({ length: maximumAttempts }, (_, index) => index + 1));
  assert.equal(state.attempts, maximumAttempts);
  assert.equal(state.outcomes.length, maximumAttempts);
  assert.equal(state.openReason, 'global-attempt-budget-exhausted');
});

test('ledger miniature multiprocessus: 20 workers concurrents ne réservent que les tentatives 1 à 9', async () => {
  const root = mkdtempSync(join(tmpdir(), 'thumbnail-item-ledger-concurrent-'));
  const workerPath = join(root, 'item-worker.mjs');
  const gatePath = join(root, 'start.gate');
  const workerCount = 20;
  const storeUrl = new URL('../media/state-store.mjs', import.meta.url).href;
  const generationUrl = new URL('../media/thumbnail-generation.mjs', import.meta.url).href;
  const itemKey = 'chaimbault:news:shared-candidate';
  writeFileSync(workerPath, `
    import { existsSync, writeFileSync } from 'node:fs';
    const [root, gatePath, readyPath, storeUrl, generationUrl, itemKey] = process.argv.slice(2);
    const { MediaStateStore } = await import(storeUrl);
    const { reserveThumbnailItemAttempt } = await import(generationUrl);
    const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
    const store = new MediaStateStore(root);
    writeFileSync(readyPath, 'ready');
    while (!existsSync(gatePath)) Atomics.wait(waitBuffer, 0, 0, 2);
    const reservation = reserveThumbnailItemAttempt({
      store,
      key: itemKey,
      minimumAttempts: 0,
      maximumAttempts: 9,
      scope: 'concurrency-test',
    });
    process.stdout.write(JSON.stringify(reservation));
  `, { mode: 0o640 });
  const children = Array.from({ length: workerCount }, (_, index) => {
    const readyPath = join(root, `item-worker-${index}.ready`);
    const child = spawn(process.execPath, [
      workerPath,
      root,
      gatePath,
      readyPath,
      storeUrl,
      generationUrl,
      itemKey,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    return { readyPath, result: childResult(child) };
  });
  await waitUntil(() => children.every(({ readyPath }) => existsSync(readyPath)));
  writeFileSync(gatePath, 'go', { mode: 0o640 });
  const results = await Promise.all(children.map(({ result }) => result));
  const accepted = results.filter((result) => result.allowed).map((result) => result.attempt).sort((a, b) => a - b);
  assert.deepEqual(accepted, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(results.filter((result) => !result.allowed).length, 11);
  const snapshot = thumbnailItemAttemptSnapshot({
    store: new MediaStateStore(root),
    key: itemKey,
    maximumAttempts: 9,
  });
  assert.equal(snapshot.attempts, 9);
  assert.equal(snapshot.exhausted, true);
});

test('thumbnail refresh multiprocessus: le timer et le manuel partagent un lease exclusif récupérable après crash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'thumbnail-refresh-cycle-lock-'));
  const workerPath = join(root, 'refresh-cycle-worker.mjs');
  const readyPath = join(root, 'holder.ready');
  const releasePath = join(root, 'holder.release');
  const stateStoreUrl = new URL('../media/state-store.mjs', import.meta.url).href;
  writeFileSync(workerPath, `
    import { existsSync, writeFileSync } from 'node:fs';
    const [mode, root, readyPath, releasePath, storeUrl] = process.argv.slice(2);
    const { MediaStateStore } = await import(storeUrl);
    const store = new MediaStateStore(root);
    const lease = store.acquireLease('thumbnail-refresh-cycle', { ttlMs: 13 * 60 * 60_000 });
    if (mode === 'hold' && lease) {
      const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
      writeFileSync(readyPath, 'ready');
      while (!existsSync(releasePath)) Atomics.wait(waitBuffer, 0, 0, 2);
      store.releaseLease(lease);
    }
    process.stdout.write(JSON.stringify({ acquired: Boolean(lease), released: mode === 'hold' && Boolean(lease) }));
  `, { mode: 0o640 });

  const holder = spawn(process.execPath, [workerPath, 'hold', root, readyPath, releasePath, stateStoreUrl], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const holderResult = childResult(holder);
  await waitUntil(() => existsSync(readyPath));
  const timerProbe = await childResult(spawn(process.execPath, [
    workerPath,
    'probe',
    root,
    readyPath,
    releasePath,
    stateStoreUrl,
  ], { stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(timerProbe.acquired, false);
  writeFileSync(releasePath, 'release', { mode: 0o640 });
  assert.deepEqual(await holderResult, { acquired: true, released: true });

  // Un processus qui meurt sans finally ne provoque pas 13 h de silence :
  // son PID local mort autorise la reprise immédiate, même avec ce grand TTL.
  const crashed = await childResult(spawn(process.execPath, [
    workerPath,
    'probe',
    root,
    readyPath,
    releasePath,
    stateStoreUrl,
  ], { stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(crashed.acquired, true);
  const successorStore = new MediaStateStore(root);
  const successor = successorStore.acquireLease('thumbnail-refresh-cycle', { ttlMs: 13 * 60 * 60_000 });
  assert.ok(successor);
  assert.equal(successorStore.releaseLease(successor), true);
});

test('plafond 9 crash-consistent: un kill après la réservation 9 interdit tout dixième appel', async () => {
  const root = mkdtempSync(join(tmpdir(), 'thumbnail-item-crash-limit-'));
  const workerPath = join(root, 'crash-after-provider-call.mjs');
  const providerMarker = join(root, 'provider-called');
  const storeUrl = new URL('../media/state-store.mjs', import.meta.url).href;
  const generationUrl = new URL('../media/thumbnail-generation.mjs', import.meta.url).href;
  const itemKey = 'chaimbault:news:candidate-crash-at-nine';
  writeFileSync(workerPath, `
    import { writeFileSync } from 'node:fs';
    const [root, marker, storeUrl, generationUrl, itemKey] = process.argv.slice(2);
    const { MediaStateStore } = await import(storeUrl);
    const { generateThumbnailWithQa, ThumbnailGenerationBudget } = await import(generationUrl);
    const store = new MediaStateStore(root);
    const budget = new ThumbnailGenerationBudget({
      maximumAttempts: 100,
      consecutiveFailureLimit: 100,
      failureRateWindow: 100,
      failureRateLimit: 1,
      stateStore: store,
    });
    await generateThumbnailWithQa({
      hermes: {
        generateBannerJson: async () => {
          writeFileSync(marker, 'called');
          process.exit(86);
        },
      },
      media: { slug: 'chaimbault' },
      draft: { title: 'Crash at nine' },
      materialize: async () => {},
      candidatePathForAttempt: () => '/tmp/unused.webp',
      budget,
      attemptLedger: {
        store,
        key: itemKey,
        minimumAttempts: 8,
        maximumAttempts: 9,
        scope: 'crash-test',
      },
      maxAttempts: 3,
    });
  `, { mode: 0o640 });
  const crashed = await childExit(spawn(process.execPath, [
    workerPath,
    root,
    providerMarker,
    storeUrl,
    generationUrl,
    itemKey,
  ], { stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(crashed.code, 86);
  assert.equal(existsSync(providerMarker), true);

  const restartedStore = new MediaStateStore(root);
  const attemptLedger = {
    store: restartedStore,
    key: itemKey,
    minimumAttempts: 8,
    maximumAttempts: 9,
    scope: 'restart-test',
  };
  assert.equal(thumbnailItemAttemptSnapshot(attemptLedger).attempts, 9);
  let tenthProviderCalls = 0;
  const restartedBudget = new ThumbnailGenerationBudget({
    maximumAttempts: 100,
    consecutiveFailureLimit: 100,
    failureRateWindow: 100,
    failureRateLimit: 1,
    stateStore: restartedStore,
  });
  const resumed = await generateThumbnailWithQa({
    hermes: { generateBannerJson: async () => { tenthProviderCalls += 1; } },
    media: { slug: 'chaimbault' },
    draft: { title: 'Crash at nine' },
    materialize: async () => {},
    candidatePathForAttempt: () => '/tmp/unused.webp',
    budget: restartedBudget,
    attemptLedger,
    maxAttempts: 3,
  });
  assert.equal(tenthProviderCalls, 0);
  assert.equal(resumed.attemptLimitReached, true);
  assert.equal(resumed.itemAttempts, 9);
  assert.equal(restartedStore.listDrafts().length, 0);
  assert.equal(restartedStore.listQueueEntries('thumbnail-refresh').length, 0);
});

test('miniature QA: trois échecs créent automatiquement une reprise persistante due ultérieurement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'thumbnail-automatic-refresh-'));
  const sourceUrl = 'https://github.blog/changelog/copilot-customize';
  const candidate = {
    id: 'github-copilot-customize-retry',
    mediaSlug: 'chaimbault',
    title: 'Copilot Customize devient disponible pour tous',
    status: 'qualified',
    score: 95,
    corroborated: true,
    rumor: false,
    sources: [{
      sourceId: 'github-official',
      tier: 0,
      official: true,
      title: 'Copilot Customize',
      url: sourceUrl,
      publishedAt: '2026-09-01T07:00:00.000Z',
    }],
  };
  const image = await articleImageBuffer();
  const store = new MediaStateStore(root);
  const budget = new ThumbnailGenerationBudget({
    maximumAttempts: 100,
    consecutiveFailureLimit: 50,
    failureRateWindow: 20,
    failureRateLimit: 1,
    stateStore: store,
  });
  const engine = new MediaEngine({
    store,
    thumbnailBudget: budget,
    env: { MEDIA_ENGINE_THUMBNAIL_MAX_TOTAL_ATTEMPTS_PER_ITEM: '9' },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name === 'content-length' ? String(image.length) : null) },
      arrayBuffer: async () => image,
    }),
    hermes: {
      generateEditorialJson: async () => articlePayload(sourceUrl),
      generateBannerJson: async () => bannerResult('https://images.invalid/copilot.png', { clipped: true }),
      inspectThumbnailJson: async ({ inspection }) => visualResult(inspection, { clipped: true }),
    },
  });

  const failed = await engine.generateDraft(candidate, { contentType: 'news' });
  const queued = store.listQueueEntries('thumbnail-refresh');
  assert.equal(failed.thumbnailGeneration.status, 'qa-failed');
  assert.equal(failed.thumbnailGeneration.attemptCount, 3);
  assert.equal(store.listQueueEntries('publication-ready').length, 0);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].payload.status, 'retry-scheduled');
  assert.equal(queued[0].payload.attempts, 3);
  assert.equal(queued[0].payload.attemptLog.length, 3);
  assert.ok(Date.parse(queued[0].payload.nextAttemptAt) > Date.now());

  // Fenêtre de crash réelle saveDraft -> enqueue : le draft produit par le
  // moteur conserve la policy QA complète et la réconciliation restaure la
  // file, sans dépendre d'un objet de test synthétique.
  const queueId = thumbnailRefreshQueueId(failed);
  store.removeQueueEntry('thumbnail-refresh', queueId);
  const recovered = reconcileThumbnailQueues(store, {
    now: new Date('2026-09-01T12:00:00.000Z'),
    publicationCutoverAt: '2026-09-01T00:00:00.000Z',
  });
  assert.deepEqual(recovered.map((entryValue) => entryValue.action), ['thumbnail-refresh-restored']);
  assert.equal(store.listQueueEntries('thumbnail-refresh')[0].payload.attempts, 3);
});

test('circuit miniature persistant: le retry est confié à la file et le cycle éditorial ne le régénère pas', async () => {
  const root = mkdtempSync(join(tmpdir(), 'thumbnail-circuit-integration-'));
  const sourceUrl = 'https://github.blog/changelog/copilot-customize';
  const candidate = {
    id: 'github-copilot-customize',
    mediaSlug: 'chaimbault',
    title: 'Copilot Customize devient disponible pour tous',
    status: 'qualified',
    score: 95,
    corroborated: true,
    rumor: false,
    sources: [{
      sourceId: 'github-official',
      tier: 0,
      official: true,
      title: 'Copilot Customize',
      url: sourceUrl,
      publishedAt: '2026-09-01T07:00:00.000Z',
    }],
  };
  const image = await articleImageBuffer();
  assert.ok(image.length > 8_000);
  const imageUrl = 'https://images.invalid/copilot.png';
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => (name === 'content-length' ? String(image.length) : null) },
    arrayBuffer: async () => image,
  });
  let clock = new Date();
  const now = () => new Date(clock);
  const firstStore = new MediaStateStore(root);
  firstStore.initialize();
  const firstBudget = new ThumbnailGenerationBudget({
    maximumAttempts: 100,
    consecutiveFailureLimit: 1,
    failureRateWindow: 20,
    cooldownMs: 60_000,
    stateStore: firstStore,
    now,
  });
  let editorialCalls = 0;
  let bannerCalls = 0;
  const firstEngine = new MediaEngine({
    store: firstStore,
    thumbnailBudget: firstBudget,
    fetchImpl,
    hermes: {
      generateEditorialJson: async () => {
        editorialCalls += 1;
        return articlePayload(sourceUrl);
      },
      generateBannerJson: async () => {
        bannerCalls += 1;
        return bannerResult(imageUrl, { clipped: true });
      },
      inspectThumbnailJson: async ({ inspection }) => visualResult(inspection, { clipped: true }),
    },
  });

  const first = await firstEngine.generateDraft(candidate, { contentType: 'news' });
  assert.equal(first.status, 'deferred');
  assert.equal(first.thumbnailGeneration.attemptCount, 1);
  assert.equal(editorialCalls, 1);
  assert.equal(bannerCalls, 1);
  assert.equal(firstStore.listDraftPaths().length, 1);
  assert.equal(firstStore.listQueueEntries('thumbnail-refresh').length, 1);
  assert.equal(firstStore.listQueueEntries('thumbnail-refresh')[0].payload.attempts, 1);
  assert.equal(firstStore.listQueueEntries('publication-ready').length, 0);

  const eventKey = `draft:chaimbault:${candidate.id}:news`;
  const retryReceipt = videoDraftReceipt(first, candidate.id);
  firstStore.markEvent(eventKey, retryReceipt);
  assert.equal(firstStore.getEvent(eventKey).status, 'thumbnail-refresh-queued');
  assert.equal(firstStore.getEvent(eventKey).thumbnailAttempts, 1);
  assert.equal(shouldGenerateDraftForEvent(firstStore, eventKey), false);

  // Une nouvelle instance simule le processus systemd suivant. Elle recharge
  // l'état ouvert et ne consomme ni appel éditorial, ni tentative d'image.
  const secondStore = new MediaStateStore(root);
  const secondBudget = new ThumbnailGenerationBudget({
    maximumAttempts: 100,
    consecutiveFailureLimit: 1,
    failureRateWindow: 20,
    cooldownMs: 60_000,
    stateStore: secondStore,
    now,
  });
  assert.equal(secondBudget.snapshot().circuitOpen, true);
  const secondEngine = new MediaEngine({
    store: secondStore,
    thumbnailBudget: secondBudget,
    fetchImpl,
    hermes: {
      generateEditorialJson: async () => { throw new Error('appel éditorial interdit circuit ouvert'); },
      generateBannerJson: async () => { throw new Error('appel image interdit circuit ouvert'); },
      inspectThumbnailJson: async () => { throw new Error('inspection interdite circuit ouvert'); },
    },
  });
  const blockedBeforeAttempt = await secondEngine.generateDraft(candidate, { contentType: 'news' });
  assert.equal(blockedBeforeAttempt.status, 'blocked');
  assert.equal(blockedBeforeAttempt.reason, 'thumbnail-refresh-queued');
  assert.equal(secondStore.listDraftPaths().length, 1);
  assert.equal(secondStore.listQueueEntries('thumbnail-refresh')[0].payload.attempts, 1);
  assert.equal(secondStore.listQueueEntries('publication-ready').length, 0);
});
