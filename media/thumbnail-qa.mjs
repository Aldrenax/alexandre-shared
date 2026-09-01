import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { ARTICLE_THUMBNAIL_POLICY, articleThumbnailProfile, officialThumbnailAssets } from './thumbnail-policy.mjs';

const MIN_PALETTE_COVERAGE = 0.60;
const MAX_PALETTE_COVERAGE = 0.70;
const MIN_MEAN_LUMINANCE = 0.28;
const DARK_LUMINANCE_THRESHOLD = 0.18;
const MAX_DARK_PIXEL_RATIO = 0.70;
const SAFE_ZONE_X = 0.06;
const SAFE_ZONE_Y = 0.06;

function issue(code, message) {
  return { code, message, severity: 'error' };
}

function normalizedText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9]+/giu, ' ')
    .trim()
    .toUpperCase();
}

export function thumbnailHeadlineWordCount(value) {
  const normalized = normalizedText(value);
  return normalized ? normalized.split(/\s+/u).length : 0;
}

function rgbFromHex(value) {
  const match = String(value || '').match(/^#([0-9a-f]{6})$/iu);
  if (!match) throw new Error(`Couleur de palette invalide: ${value}`);
  return [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16));
}

function hueAndSaturation(red, green, blue) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  const delta = maximum - minimum;
  const saturation = maximum === 0 ? 0 : delta / maximum;
  if (delta === 0) return { hue: 0, saturation };
  let hue;
  if (maximum === r) hue = 60 * (((g - b) / delta) % 6);
  else if (maximum === g) hue = 60 * (((b - r) / delta) + 2);
  else hue = 60 * (((r - g) / delta) + 4);
  return { hue: hue < 0 ? hue + 360 : hue, saturation };
}

function hueDistance(left, right) {
  const difference = Math.abs(left - right);
  return Math.min(difference, 360 - difference);
}

export function paletteCoverageFromPixels(data, { channels = 3, colors }) {
  if (!data?.length || !Number.isInteger(channels) || channels < 3) return 0;
  const targets = colors.map((color) => hueAndSaturation(...rgbFromHex(color)));
  let matching = 0;
  let total = 0;
  for (let offset = 0; offset + 2 < data.length; offset += channels) {
    const sample = hueAndSaturation(data[offset], data[offset + 1], data[offset + 2]);
    total += 1;
    if (sample.saturation < 0.18) continue;
    if (targets.some((target) => hueDistance(sample.hue, target.hue) <= 28)) matching += 1;
  }
  return total ? matching / total : 0;
}

export function luminanceMetricsFromPixels(data, { channels = 3 } = {}) {
  if (!data?.length || !Number.isInteger(channels) || channels < 3) {
    return { meanLuminance: 0, darkPixelRatio: 1 };
  }
  let luminanceTotal = 0;
  let darkPixels = 0;
  let total = 0;
  for (let offset = 0; offset + 2 < data.length; offset += channels) {
    const luminance = (
      (0.2126 * data[offset])
      + (0.7152 * data[offset + 1])
      + (0.0722 * data[offset + 2])
    ) / 255;
    luminanceTotal += luminance;
    if (luminance < DARK_LUMINANCE_THRESHOLD) darkPixels += 1;
    total += 1;
  }
  return {
    meanLuminance: total ? luminanceTotal / total : 0,
    darkPixelRatio: total ? darkPixels / total : 1,
  };
}

export function thumbnailFileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export async function inspectThumbnailFile(path, media, { sharpImpl = null } = {}) {
  const sharp = sharpImpl || (await import('sharp')).default;
  // Hash, metadata and pixel metrics all derive from the same immutable byte
  // snapshot. A path swap during inspection therefore cannot mix two files.
  const bytes = readFileSync(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const image = sharp(bytes);
  const metadata = await image.metadata();
  const { data, info } = await image
    .clone()
    .resize(160, 90, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const luminance = luminanceMetricsFromPixels(data, { channels: info.channels });
  return {
    path,
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
    pages: metadata.pages || 1,
    byteLength: bytes.length,
    sha256,
    paletteCoverage: paletteCoverageFromPixels(data, {
      channels: info.channels,
      colors: articleThumbnailProfile(media).colors,
    }),
    ...luminance,
  };
}

function brandedAssetIssues(visualInspection, draft) {
  const issues = [];
  const allowed = officialThumbnailAssets(draft);
  for (const [field, kind] of [['usesLogo', 'logo'], ['usesInterface', 'interface'], ['usesFace', 'face']]) {
    const value = visualInspection?.[field];
    if (typeof value !== 'boolean') {
      issues.push(issue(`thumbnail-${kind}-inspection-missing`, `${kind} non vérifié par l'inspection indépendante`));
    } else if (value === true && !allowed.some((asset) => asset.kind === kind)) {
      issues.push(issue(`thumbnail-unapproved-${kind}`, `${kind} détecté sans asset officiel autorisé`));
    }
  }
  return issues;
}

function textBoundingBoxIssues(visualInspection, expectedText) {
  const issues = [];
  const box = visualInspection?.textBoundingBox;
  if (!expectedText) {
    if (box != null) issues.push(issue('thumbnail-unexpected-text-box', 'Une zone de texte est détectée alors qu’aucun texte n’est attendu'));
    return issues;
  }
  if (!box || typeof box !== 'object') {
    issues.push(issue('thumbnail-text-safe-zone-missing', 'Position du texte non vérifiée par l’inspection indépendante'));
    return issues;
  }
  const coordinates = ['left', 'top', 'right', 'bottom'].map((field) => Number(box[field]));
  if (
    coordinates.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
    || coordinates[0] >= coordinates[2]
    || coordinates[1] >= coordinates[3]
  ) {
    issues.push(issue('thumbnail-text-bounds-invalid', 'Coordonnées normalisées du texte invalides'));
    return issues;
  }
  const [left, top, right, bottom] = coordinates;
  if (left < SAFE_ZONE_X || right > 1 - SAFE_ZONE_X || top < SAFE_ZONE_Y || bottom > 1 - SAFE_ZONE_Y) {
    issues.push(issue('thumbnail-text-outside-safe-zone', 'Le texte empiète sur les marges de sécurité'));
  }
  return issues;
}

function independentVisualIssues(visualInspection, draft, inspection) {
  const issues = [];
  if (!visualInspection || typeof visualInspection !== 'object') {
    return [issue('thumbnail-independent-vision-missing', 'Seconde inspection Hermes vision absente')];
  }
  if (visualInspection.method !== 'hermes-vision' || visualInspection.independent !== true) {
    issues.push(issue('thumbnail-independent-vision-invalid', 'Inspection visuelle indépendante non prouvée'));
  }
  if (visualInspection.success !== true) {
    issues.push(issue('thumbnail-independent-vision-failed', 'Hermes vision n’a pas validé l’image normalisée'));
  }
  if (!inspection?.sha256 || visualInspection.sha256 !== inspection.sha256) {
    issues.push(issue('thumbnail-vision-hash-mismatch', 'L’inspection vision ne porte pas sur les mêmes octets normalisés'));
  }
  const expectedText = normalizedText(draft?.bannerBrief?.headline);
  const observedText = normalizedText(visualInspection.observedText);
  if (observedText !== expectedText || visualInspection.textExact !== true) {
    issues.push(issue('thumbnail-text-mismatch', `Texte observé différent du texte attendu: ${observedText || '(vide)'}`));
  }
  if (visualInspection.textClipped !== false) {
    issues.push(issue('thumbnail-text-clipped', 'Texte rogné ou non vérifié sur l’image normalisée'));
  }
  if (expectedText && visualInspection.mobileReadable !== true) {
    issues.push(issue('thumbnail-mobile-unreadable', 'Lisibilité mobile non confirmée sur l’image normalisée'));
  }
  issues.push(...textBoundingBoxIssues(visualInspection, expectedText));
  issues.push(...brandedAssetIssues(visualInspection, draft));
  return issues;
}

export function evaluateThumbnailCandidate({ draft, media, modelResult, inspection, visualInspection }) {
  const issues = [];
  const modelQa = modelResult?.qa;
  const providerDeclaredSuccess = modelResult?.providerDeclaredSuccess ?? modelResult?.success === true;
  const recoveredFromUnconfirmedGeneration = (
    providerDeclaredSuccess === false
    && modelResult?.recoveredFromUnconfirmedGeneration === true
  );
  if (modelResult?.success !== true && !recoveredFromUnconfirmedGeneration) {
    issues.push(issue('thumbnail-generation-unsuccessful', 'Hermes ne confirme pas la génération'));
  }
  const headlineWords = thumbnailHeadlineWordCount(draft?.bannerBrief?.headline);
  if (headlineWords !== 0 && (headlineWords < 2 || headlineWords > 4)) {
    issues.push(issue('thumbnail-headline-word-count-invalid', `Le headline doit être vide ou contenir 2 à 4 mots; ${headlineWords} reçus`));
  }
  if (!inspection) {
    issues.push(issue('thumbnail-file-inspection-missing', 'Inspection déterministe du fichier absente'));
  } else {
    if (inspection.format !== 'webp' || extname(String(inspection.path || '')).toLowerCase() !== '.webp') {
      issues.push(issue('thumbnail-format-invalid', 'Le seul asset final doit être un WebP'));
    }
    if (inspection.width !== 1_280 || inspection.height !== 720) {
      issues.push(issue('thumbnail-dimensions-invalid', `Dimensions reçues: ${inspection.width || 0}x${inspection.height || 0}`));
    }
    if (inspection.pages !== 1) issues.push(issue('thumbnail-asset-count-invalid', 'Le WebP final doit contenir une seule image non animée'));
    if (!/^[a-f0-9]{64}$/u.test(String(inspection.sha256 || ''))) {
      issues.push(issue('thumbnail-file-hash-missing', 'Empreinte SHA-256 du fichier inspecté absente'));
    }
    const coverage = Number(inspection.paletteCoverage);
    if (!Number.isFinite(coverage) || coverage < MIN_PALETTE_COVERAGE || coverage > MAX_PALETTE_COVERAGE) {
      issues.push(issue('thumbnail-palette-coverage-invalid', `Couverture palette reçue: ${Number.isFinite(coverage) ? coverage.toFixed(3) : 'inconnue'}`));
    }
    const meanLuminance = Number(inspection.meanLuminance);
    const darkPixelRatio = Number(inspection.darkPixelRatio);
    if (
      !Number.isFinite(meanLuminance)
      || meanLuminance < MIN_MEAN_LUMINANCE
      || !Number.isFinite(darkPixelRatio)
      || darkPixelRatio > MAX_DARK_PIXEL_RATIO
    ) {
      issues.push(issue(
        'thumbnail-luminance-invalid',
        `Luminosité insuffisante: moyenne ${Number.isFinite(meanLuminance) ? meanLuminance.toFixed(3) : 'inconnue'}, pixels sombres ${Number.isFinite(darkPixelRatio) ? darkPixelRatio.toFixed(3) : 'inconnu'}`,
      ));
    }
  }
  issues.push(...independentVisualIssues(visualInspection, draft, inspection));
  return {
    version: 2,
    policy: ARTICLE_THUMBNAIL_POLICY,
    checkedAt: new Date().toISOString(),
    passed: issues.length === 0,
    issueCodes: issues.map((entry) => entry.code),
    issues,
    inspection: inspection || null,
    visualInspection: visualInspection || null,
    inspectionMode: 'deterministic-pixels-plus-independent-hermes-vision',
    modelQa: modelQa || null,
    generationProvenance: {
      providerDeclaredSuccess,
      recoveredFromUnconfirmedGeneration,
    },
  };
}

export function thumbnailPublicationBlockers(draft) {
  if (draft?.contentType === 'video') return [];
  if (!['news', 'guide'].includes(draft?.contentType)) return ['thumbnail-content-type-unsupported'];
  const blockers = [];
  if (draft?.banner?.qa?.passed !== true) blockers.push('thumbnail-qa-failed');
  if (draft?.banner?.qa?.policy !== ARTICLE_THUMBNAIL_POLICY) blockers.push('thumbnail-policy-stale');
  if (draft?.banner?.width !== 1_280 || draft?.banner?.height !== 720) blockers.push('thumbnail-dimensions-invalid');
  const bannerPath = String(draft?.banner?.path || '');
  if (extname(bannerPath).toLowerCase() !== '.webp') blockers.push('thumbnail-format-invalid');
  const inspectedSha256 = String(draft?.banner?.qa?.inspection?.sha256 || '');
  const visionSha256 = String(draft?.banner?.qa?.visualInspection?.sha256 || '');
  if (!/^[a-f0-9]{64}$/u.test(inspectedSha256)) blockers.push('thumbnail-file-hash-missing');
  if (!/^[a-f0-9]{64}$/u.test(visionSha256) || visionSha256 !== inspectedSha256) blockers.push('thumbnail-vision-hash-mismatch');
  if (!bannerPath || !existsSync(bannerPath)) {
    blockers.push('thumbnail-file-missing');
  } else if (/^[a-f0-9]{64}$/u.test(inspectedSha256)) {
    try {
      if (thumbnailFileSha256(bannerPath) !== inspectedSha256) blockers.push('thumbnail-file-mutated-after-qa');
    } catch {
      blockers.push('thumbnail-file-unreadable');
    }
  }
  return [...new Set(blockers)];
}

export const THUMBNAIL_PALETTE_RANGE = Object.freeze({ min: MIN_PALETTE_COVERAGE, max: MAX_PALETTE_COVERAGE });
export const THUMBNAIL_LUMINANCE_LIMITS = Object.freeze({
  minMean: MIN_MEAN_LUMINANCE,
  darkThreshold: DARK_LUMINANCE_THRESHOLD,
  maxDarkPixelRatio: MAX_DARK_PIXEL_RATIO,
});
export const THUMBNAIL_SAFE_ZONES = Object.freeze({ x: SAFE_ZONE_X, y: SAFE_ZONE_Y });
