import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';

import {
  DEFAULT_EDITORIAL_MODEL,
  DEFAULT_EDITORIAL_PROVIDER,
  HermesClient,
} from './hermes-client.mjs';
import { mediaBySlug } from './registry.mjs';
import { evaluateThumbnailCandidate, inspectThumbnailFile } from './thumbnail-qa.mjs';

const CHECK_ID = 'thumbnail-vision-preflight';
const FIXTURE_WIDTH = 1_280;
const FIXTURE_HEIGHT = 720;
const PALETTE_WIDTH = 832;

function selectedVisionRuntime(hermes, env = process.env) {
  const clientEnv = hermes?.env || env;
  return {
    provider: clientEnv.HERMES_VISION_PROVIDER
      || clientEnv.HERMES_EDITORIAL_PROVIDER
      || DEFAULT_EDITORIAL_PROVIDER,
    model: clientEnv.HERMES_VISION_MODEL
      || clientEnv.HERMES_EDITORIAL_MODEL
      || DEFAULT_EDITORIAL_MODEL,
    toolset: 'vision',
  };
}

async function writeFixture(path, { sharpImpl = sharp } = {}) {
  await sharpImpl({
    create: {
      width: FIXTURE_WIDTH,
      height: FIXTURE_HEIGHT,
      channels: 3,
      background: '#A0A0A0',
    },
  })
    .composite([{
      input: {
        create: {
          width: PALETTE_WIDTH,
          height: FIXTURE_HEIGHT,
          channels: 3,
          background: '#1394C7',
        },
      },
      left: 0,
      top: 0,
    }])
    .webp({ lossless: true })
    .toFile(path);
  chmodSync(path, 0o640);
}

export async function runThumbnailVisionPreflight({
  hermes = new HermesClient(),
  media = mediaBySlug('chaimbault'),
  env = process.env,
  fixtureParent = tmpdir(),
  sharpImpl = sharp,
  inspect = inspectThumbnailFile,
  now = () => new Date(),
} = {}) {
  const runtime = selectedVisionRuntime(hermes, env);
  const observedAt = now().toISOString();
  let fixtureDirectory = null;
  let fixturePath = null;
  try {
    if (!media) throw new Error('Média de canari miniature introuvable');
    mkdirSync(fixtureParent, { recursive: true, mode: 0o750 });
    fixtureDirectory = mkdtempSync(join(fixtureParent, `${CHECK_ID}-`));
    fixturePath = join(fixtureDirectory, 'fixture.webp');
    await writeFixture(fixturePath, { sharpImpl });

    const inspection = await inspect(fixturePath, media, { sharpImpl });
    const draft = {
      mediaSlug: media.slug,
      contentType: 'news',
      title: 'Canari technique sans texte',
      bannerBrief: {
        headline: '',
        concept: 'Aplat technique bicolore sans marque',
        alt: 'Canari technique bicolore',
      },
    };
    const visualInspection = await hermes.inspectThumbnailJson({
      path: fixturePath,
      media,
      draft,
      inspection,
    });
    const qa = evaluateThumbnailCandidate({
      draft,
      media,
      modelResult: { success: true, qa: { canary: true } },
      inspection,
      visualInspection,
    });
    return {
      version: 1,
      check: CHECK_ID,
      passed: qa.passed,
      observedAt,
      runtime,
      inspection: {
        format: inspection.format,
        width: inspection.width,
        height: inspection.height,
        pages: inspection.pages,
        sha256: inspection.sha256,
        paletteCoverage: inspection.paletteCoverage,
        meanLuminance: inspection.meanLuminance,
        darkPixelRatio: inspection.darkPixelRatio,
      },
      vision: {
        method: visualInspection?.method || null,
        independent: visualInspection?.independent === true,
        success: visualInspection?.success === true,
        sha256: visualInspection?.sha256 || null,
        observedText: visualInspection?.observedText ?? null,
        usesLogo: visualInspection?.usesLogo ?? null,
        usesInterface: visualInspection?.usesInterface ?? null,
        usesFace: visualInspection?.usesFace ?? null,
      },
      issueCodes: qa.issueCodes,
      issues: qa.issues,
      fixtureCleaned: true,
    };
  } catch (error) {
    return {
      version: 1,
      check: CHECK_ID,
      passed: false,
      observedAt,
      runtime,
      inspection: null,
      vision: null,
      issueCodes: ['thumbnail-vision-preflight-failed'],
      issues: [{
        code: 'thumbnail-vision-preflight-failed',
        severity: 'error',
        message: String(error?.message || error),
      }],
      fixtureCleaned: true,
    };
  } finally {
    if (fixtureDirectory && existsSync(fixtureDirectory)) {
      rmSync(fixtureDirectory, { recursive: true, force: true });
    }
  }
}
