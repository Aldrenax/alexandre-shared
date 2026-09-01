import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runThumbnailVisionPreflight } from '../media/thumbnail-vision-preflight.mjs';

test('canari vision miniature: inspecte le WebP final avec Hermes puis nettoie toujours le fixture', async () => {
  const fixtureParent = mkdtempSync(join(tmpdir(), 'thumbnail-vision-preflight-test-'));
  let stagedFixturePath = null;
  let deterministicInspection = null;
  const hermes = {
    env: {
      HERMES_VISION_PROVIDER: 'provider-canary',
      HERMES_VISION_MODEL: 'model-canary',
    },
    inspectThumbnailJson: async ({ path, draft, inspection }) => {
      stagedFixturePath = path;
      deterministicInspection = inspection;
      assert.equal(existsSync(path), true);
      assert.equal(draft.bannerBrief.headline, '');
      assert.equal(inspection.format, 'webp');
      assert.equal(inspection.width, 1_280);
      assert.equal(inspection.height, 720);
      return {
        method: 'hermes-vision',
        independent: true,
        success: true,
        sha256: inspection.sha256,
        observedText: '',
        textExact: true,
        textClipped: false,
        mobileReadable: true,
        textBoundingBox: null,
        usesLogo: false,
        usesInterface: false,
        usesFace: false,
      };
    },
  };

  const result = await runThumbnailVisionPreflight({ hermes, fixtureParent });

  assert.equal(result.check, 'thumbnail-vision-preflight');
  assert.equal(result.passed, true, JSON.stringify(result.issues));
  assert.deepEqual(result.runtime, {
    provider: 'provider-canary',
    model: 'model-canary',
    toolset: 'vision',
  });
  assert.equal(result.inspection.sha256, deterministicInspection.sha256);
  assert.equal(result.vision.sha256, deterministicInspection.sha256);
  assert.equal(result.vision.observedText, '');
  assert.equal(result.vision.usesLogo, false);
  assert.equal(result.vision.usesInterface, false);
  assert.equal(result.vision.usesFace, false);
  assert.ok(result.inspection.paletteCoverage >= 0.60 && result.inspection.paletteCoverage <= 0.70);
  assert.equal(result.fixtureCleaned, true);
  assert.equal(existsSync(stagedFixturePath), false);
});
test('canari vision miniature: une erreur Hermes produit un verdict machine négatif et nettoie le fixture', async () => {
  const fixtureParent = mkdtempSync(join(tmpdir(), 'thumbnail-vision-preflight-failure-'));
  let stagedFixturePath = null;
  const result = await runThumbnailVisionPreflight({
    fixtureParent,
    hermes: {
      env: {},
      inspectThumbnailJson: async ({ path }) => {
        stagedFixturePath = path;
        throw new Error('toolset vision indisponible');
      },
    },
  });

  assert.equal(result.check, 'thumbnail-vision-preflight');
  assert.equal(result.passed, false);
  assert.deepEqual(result.issueCodes, ['thumbnail-vision-preflight-failed']);
  assert.match(result.issues[0].message, /toolset vision indisponible/u);
  assert.equal(result.fixtureCleaned, true);
  assert.equal(existsSync(stagedFixturePath), false);
});
