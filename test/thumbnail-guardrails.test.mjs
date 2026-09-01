import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';

import { HermesClient } from '../media/hermes-client.mjs';
import {
  generateThumbnailWithQa,
  ThumbnailGenerationBudget,
} from '../media/thumbnail-generation.mjs';
import {
  evaluateThumbnailCandidate,
  inspectThumbnailFile,
  paletteCoverageFromPixels,
  thumbnailPublicationBlockers,
} from '../media/thumbnail-qa.mjs';
import { ARTICLE_THUMBNAIL_POLICY, officialThumbnailAssets } from '../media/thumbnail-policy.mjs';

const media = { slug: 'chaimbault', name: 'Alexandre Chaimbault' };
const draft = {
  mediaSlug: 'chaimbault',
  contentType: 'news',
  title: 'Copilot Customize arrive',
  description: 'Annonce factuelle.',
  bannerBrief: { headline: 'COPILOT CUSTOMIZE', concept: 'Objet technique générique' },
};

function modelResult(overrides = {}) {
  const { qa: qaOverrides = {}, ...resultOverrides } = overrides;
  return {
    success: true,
    imageSource: '/cache/result.png',
    alt: 'Illustration technique Copilot Customize',
    width: 1_280,
    height: 720,
    qa: {
      finalAssetCount: 1,
      paletteCoverage: 0.65,
      observedText: 'COPILOT CUSTOMIZE',
      textExact: true,
      textClipped: false,
      mobileReadable: true,
      usesLogo: false,
      usesInterface: false,
      usesFace: false,
      assetSources: [],
      fakeLogo: false,
      fakeInterface: false,
      fakeFace: false,
      ...qaOverrides,
    },
    ...resultOverrides,
  };
}

const inspection = {
  path: '/tmp/candidate.webp',
  format: 'webp',
  width: 1_280,
  height: 720,
  pages: 1,
  sha256: 'a'.repeat(64),
  paletteCoverage: 0.65,
  meanLuminance: 0.55,
  darkPixelRatio: 0.10,
};

function visualInspection(overrides = {}) {
  return {
    success: true,
    method: 'hermes-vision',
    independent: true,
    sha256: inspection.sha256,
    observedText: 'COPILOT CUSTOMIZE',
    textExact: true,
    textClipped: false,
    mobileReadable: true,
    textBoundingBox: { left: 0.10, top: 0.15, right: 0.62, bottom: 0.40 },
    usesLogo: false,
    usesInterface: false,
    usesFace: false,
    ...overrides,
  };
}

test('miniature QA: la couverture de palette est mesurée sur les pixels', () => {
  const pixels = Buffer.alloc(100 * 3);
  for (let index = 0; index < 100; index += 1) {
    const rgb = index < 65 ? [0x13, 0x94, 0xC7] : [0xEE, 0xEE, 0xEE];
    pixels.set(rgb, index * 3);
  }
  assert.equal(paletteCoverageFromPixels(pixels, { channels: 3, colors: ['#1394C7'] }), 0.65);
});

test('miniature QA: WebP 1280x720, palette, texte et représentation passent ensemble', () => {
  const qa = evaluateThumbnailCandidate({ draft, media, modelResult: modelResult(), inspection, visualInspection: visualInspection() });
  assert.equal(qa.passed, true, JSON.stringify(qa.issues));
  assert.equal(qa.policy, ARTICLE_THUMBNAIL_POLICY);
});

test('miniature QA: hors palette, texte rogné et logo non autorisé bloquent la publication', () => {
  const qa = evaluateThumbnailCandidate({
    draft,
    media,
    modelResult: modelResult(),
    inspection: { ...inspection, paletteCoverage: 0.25 },
    visualInspection: visualInspection({ textClipped: true, usesLogo: true }),
  });
  assert.equal(qa.passed, false);
  assert.ok(qa.issueCodes.includes('thumbnail-palette-coverage-invalid'));
  assert.ok(qa.issueCodes.includes('thumbnail-text-clipped'));
  assert.ok(qa.issueCodes.includes('thumbnail-unapproved-logo'));
  const overDominant = evaluateThumbnailCandidate({
    draft,
    media,
    modelResult: modelResult(),
    inspection: { ...inspection, paletteCoverage: 0.80 },
    visualInspection: visualInspection(),
  });
  assert.ok(overDominant.issueCodes.includes('thumbnail-palette-coverage-invalid'));
});

test('miniature QA: logo ou interface exigent un asset officiel allowlisté', () => {
  const generatedDraft = {
    ...draft,
    bannerBrief: { ...draft.bannerBrief, officialAssets: ['https://example.com/logo-invente.png'] },
  };
  assert.deepEqual(officialThumbnailAssets(generatedDraft), []);
  const qa = evaluateThumbnailCandidate({
    draft: generatedDraft,
    media,
    modelResult: modelResult(),
    inspection,
    visualInspection: visualInspection({ usesLogo: true }),
  });
  assert.equal(qa.passed, false);
  assert.ok(qa.issueCodes.includes('thumbnail-unapproved-logo'));
});

test('génération miniature: une réparation automatique reste bornée par le budget global', async () => {
  const prompts = [];
  const responses = [modelResult(), modelResult()];
  const visionResponses = [visualInspection({ textClipped: true }), visualInspection()];
  const budget = new ThumbnailGenerationBudget({ maximumAttempts: 10, consecutiveFailureLimit: 8 });
  const result = await generateThumbnailWithQa({
    hermes: {
      generateBannerJson: async (prompt) => { prompts.push(prompt); return responses.shift(); },
      inspectThumbnailJson: async ({ inspection: inspected }) => ({ ...visionResponses.shift(), sha256: inspected.sha256 }),
    },
    media,
    draft,
    materialize: async () => {},
    candidatePathForAttempt: (attempt) => `/tmp/candidate-${attempt}.webp`,
    budget,
    maxAttempts: 3,
    inspect: async (path) => ({ ...inspection, path }),
    now: () => new Date('2026-09-01T08:00:00.000Z'),
  });
  assert.equal(result.passed, true);
  assert.equal(result.attempts.length, 2);
  assert.match(prompts[1], /CORRECTIVE ATTEMPT 2/);
  assert.equal(budget.snapshot().attempts, 2);
});

test('génération miniature: le coupe-circuit interrompt une série d’échecs', async () => {
  const budget = new ThumbnailGenerationBudget({ maximumAttempts: 100, consecutiveFailureLimit: 2, failureRateWindow: 20 });
  const result = await generateThumbnailWithQa({
    hermes: {
      generateBannerJson: async () => modelResult(),
      inspectThumbnailJson: async ({ inspection: inspected }) => ({ ...visualInspection({ textClipped: true }), sha256: inspected.sha256 }),
    },
    media,
    draft,
    materialize: async () => {},
    candidatePathForAttempt: (attempt) => `/tmp/candidate-${attempt}.webp`,
    budget,
    maxAttempts: 9,
    inspect: async (path) => ({ ...inspection, path }),
  });
  assert.equal(result.passed, false);
  assert.equal(result.attempts.length, 2);
  assert.equal(budget.snapshot().circuitOpen, true);
});

test('miniature QA: cyan sombre et headline de onze mots échouent après normalisation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'thumbnail-dark-long-'));
  const path = join(root, 'normalized.webp');
  const darkCyan = await sharp({
    create: { width: 832, height: 720, channels: 3, background: '#031C25' },
  }).png().toBuffer();
  await sharp({
    create: { width: 1_280, height: 720, channels: 3, background: '#050505' },
  }).composite([{ input: darkCyan, left: 0, top: 0 }]).webp().toFile(path);
  const inspected = await inspectThumbnailFile(path, media);
  const longDraft = {
    ...draft,
    bannerBrief: { ...draft.bannerBrief, headline: 'VOICI ONZE MOTS BEAUCOUP TROP LONGS POUR UNE MINIATURE SUR MOBILE' },
  };
  const qa = evaluateThumbnailCandidate({
    draft: longDraft,
    media,
    modelResult: modelResult(),
    inspection: inspected,
    visualInspection: visualInspection({
      sha256: inspected.sha256,
      observedText: longDraft.bannerBrief.headline,
      textBoundingBox: { left: 0.08, top: 0.10, right: 0.92, bottom: 0.40 },
    }),
  });
  assert.equal(qa.passed, false);
  assert.ok(qa.issueCodes.includes('thumbnail-headline-word-count-invalid'));
  assert.ok(qa.issueCodes.includes('thumbnail-luminance-invalid'));
});

test('génération miniature: le recadrage final est inspecté avant le verdict vision', async () => {
  let normalized = false;
  const budget = new ThumbnailGenerationBudget({ maximumAttempts: 2, consecutiveFailureLimit: 2 });
  const result = await generateThumbnailWithQa({
    hermes: {
      generateBannerJson: async () => modelResult(),
      inspectThumbnailJson: async ({ inspection: inspected }) => {
        assert.equal(normalized, true);
        return { ...visualInspection({ textClipped: true }), sha256: inspected.sha256 };
      },
    },
    media,
    draft,
    materialize: async () => { normalized = true; },
    candidatePathForAttempt: () => '/tmp/final-crop.webp',
    budget,
    maxAttempts: 1,
    inspect: async (path) => {
      assert.equal(normalized, true);
      return { ...inspection, path };
    },
  });
  assert.equal(result.passed, false);
  assert.ok(result.qa.issueCodes.includes('thumbnail-text-clipped'));
});

test('Hermes vision: staging dédié puis nettoyage sur succès et erreur', async () => {
  const root = mkdtempSync(join(tmpdir(), 'thumbnail-vision-stage-'));
  const path = join(root, 'normalized.webp');
  const cache = join(root, 'writable-media-engine');
  const bytes = Buffer.from('normalized-thumbnail-fixture');
  writeFileSync(path, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const client = new HermesClient({
    command: ['true'],
    env: {
      HERMES_VISION_STAGING_HOST_ROOT: cache,
      HERMES_VISION_STAGING_CONTAINER_ROOT: '/opt/data/media-engine',
      HERMES_DOCKER_USER: `${process.getuid()}:${process.getgid()}`,
    },
  });
  const prompts = [];
  client.oneshotJson = async (prompt, options) => {
    prompts.push({ prompt, options });
    const staged = readdirSync(join(cache, 'thumbnail-qa'));
    assert.equal(staged.length, 1);
    const stagingDirectory = statSync(join(cache, 'thumbnail-qa'));
    const stagedFile = statSync(join(cache, 'thumbnail-qa', staged[0]));
    assert.equal(stagingDirectory.uid, process.getuid());
    assert.equal(stagingDirectory.gid, process.getgid());
    assert.equal(stagedFile.uid, process.getuid());
    assert.equal(stagedFile.gid, process.getgid());
    assert.equal(stagingDirectory.mode & 0o777, 0o750);
    assert.equal(stagedFile.mode & 0o777, 0o640);
    return visualInspection({ sha256: undefined });
  };
  const result = await client.inspectThumbnailJson({ path, media, draft, inspection: { sha256 } });
  assert.equal(result.sha256, sha256);
  assert.match(prompts[0].prompt, /\/opt\/data\/media-engine\/thumbnail-qa\//u);
  assert.deepEqual(prompts[0].options.toolsets, ['vision']);
  assert.deepEqual(readdirSync(join(cache, 'thumbnail-qa')), []);
  client.oneshotJson = async () => { throw new Error('vision indisponible'); };
  await assert.rejects(() => client.inspectThumbnailJson({ path, media, draft, inspection: { sha256 } }), /vision indisponible/u);
  assert.deepEqual(readdirSync(join(cache, 'thumbnail-qa')), []);
});

test('publication: un ancien article sans QA miniature v4 reste bloqué', () => {
  assert.deepEqual(thumbnailPublicationBlockers({ contentType: 'video' }), []);
  const blockers = thumbnailPublicationBlockers({
    contentType: 'news',
    banner: { path: '/tmp/old.webp', width: 1_280, height: 720, qa: { passed: true, policy: 'v2' } },
  });
  assert.ok(blockers.includes('thumbnail-policy-stale'));
});
