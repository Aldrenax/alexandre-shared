import assert from 'node:assert/strict';
import test from 'node:test';

import {
  generateThumbnailWithQa,
  ThumbnailGenerationBudget,
} from '../media/thumbnail-generation.mjs';
import {
  evaluateThumbnailCandidate,
  paletteCoverageFromPixels,
  thumbnailPublicationBlockers,
} from '../media/thumbnail-qa.mjs';
import { ARTICLE_THUMBNAIL_POLICY } from '../media/thumbnail-policy.mjs';

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
  paletteCoverage: 0.65,
};

test('miniature QA: la couverture de palette est mesurée sur les pixels', () => {
  const pixels = Buffer.alloc(100 * 3);
  for (let index = 0; index < 100; index += 1) {
    const rgb = index < 65 ? [0x13, 0x94, 0xC7] : [0xEE, 0xEE, 0xEE];
    pixels.set(rgb, index * 3);
  }
  assert.equal(paletteCoverageFromPixels(pixels, { channels: 3, colors: ['#1394C7'] }), 0.65);
});

test('miniature QA: WebP 1280x720, palette, texte et représentation passent ensemble', () => {
  const qa = evaluateThumbnailCandidate({ draft, media, modelResult: modelResult(), inspection });
  assert.equal(qa.passed, true, JSON.stringify(qa.issues));
  assert.equal(qa.policy, ARTICLE_THUMBNAIL_POLICY);
});

test('miniature QA: hors palette, texte rogné et faux logo bloquent la publication', () => {
  const qa = evaluateThumbnailCandidate({
    draft,
    media,
    modelResult: modelResult({ qa: { textClipped: true, fakeLogo: true } }),
    inspection: { ...inspection, paletteCoverage: 0.25 },
  });
  assert.equal(qa.passed, false);
  assert.ok(qa.issueCodes.includes('thumbnail-palette-coverage-invalid'));
  assert.ok(qa.issueCodes.includes('thumbnail-text-clipped'));
  assert.ok(qa.issueCodes.includes('thumbnail-fake-logo'));
  const overDominant = evaluateThumbnailCandidate({
    draft,
    media,
    modelResult: modelResult(),
    inspection: { ...inspection, paletteCoverage: 0.80 },
  });
  assert.ok(overDominant.issueCodes.includes('thumbnail-palette-coverage-invalid'));
});

test('miniature QA: logo ou interface exigent un asset officiel allowlisté', () => {
  const qa = evaluateThumbnailCandidate({
    draft,
    media,
    modelResult: modelResult({ qa: { usesLogo: true } }),
    inspection,
  });
  assert.equal(qa.passed, false);
  assert.ok(qa.issueCodes.includes('thumbnail-unapproved-logo'));
});

test('génération miniature: une réparation automatique reste bornée par le budget global', async () => {
  const prompts = [];
  const responses = [modelResult({ qa: { textClipped: true } }), modelResult()];
  const budget = new ThumbnailGenerationBudget({ maximumAttempts: 10, consecutiveFailureLimit: 8 });
  const result = await generateThumbnailWithQa({
    hermes: { generateBannerJson: async (prompt) => { prompts.push(prompt); return responses.shift(); } },
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
    hermes: { generateBannerJson: async () => modelResult({ qa: { textClipped: true } }) },
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

test('publication: un ancien article sans QA miniature v3 reste bloqué', () => {
  assert.deepEqual(thumbnailPublicationBlockers({ contentType: 'video' }), []);
  const blockers = thumbnailPublicationBlockers({
    contentType: 'news',
    banner: { path: '/tmp/old.webp', width: 1_280, height: 720, qa: { passed: true, policy: 'v2' } },
  });
  assert.ok(blockers.includes('thumbnail-policy-stale'));
});
