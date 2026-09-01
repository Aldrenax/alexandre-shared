import { extname } from 'node:path';
import { ARTICLE_THUMBNAIL_POLICY, articleThumbnailProfile, officialThumbnailAssets } from './thumbnail-policy.mjs';

const MIN_PALETTE_COVERAGE = 0.60;
const MAX_PALETTE_COVERAGE = 0.70;

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

export async function inspectThumbnailFile(path, media, { sharpImpl = null } = {}) {
  const sharp = sharpImpl || (await import('sharp')).default;
  const image = sharp(path);
  const metadata = await image.metadata();
  const { data, info } = await image
    .clone()
    .resize(160, 90, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    path,
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
    paletteCoverage: paletteCoverageFromPixels(data, {
      channels: info.channels,
      colors: articleThumbnailProfile(media).colors,
    }),
  };
}

function brandedAssetIssues(modelQa, draft) {
  const issues = [];
  const allowed = officialThumbnailAssets(draft);
  const allowedUrls = new Set(allowed.map((asset) => asset.url));
  const usedSources = Array.isArray(modelQa?.assetSources) ? modelQa.assetSources : null;
  if (!usedSources) issues.push(issue('thumbnail-asset-sources-missing', 'Liste des assets de référence utilisée absente'));
  for (const source of usedSources || []) {
    if (!allowedUrls.has(String(source))) issues.push(issue('thumbnail-unapproved-asset', `Asset visuel non autorisé: ${source}`));
  }
  for (const [field, kind] of [['usesLogo', 'logo'], ['usesInterface', 'interface'], ['usesFace', 'face']]) {
    if (modelQa?.[field] === true && !allowed.some((asset) => asset.kind === kind)) {
      issues.push(issue(`thumbnail-unapproved-${kind}`, `${kind} utilisé sans asset officiel autorisé`));
    }
  }
  return issues;
}

export function evaluateThumbnailCandidate({ draft, media, modelResult, inspection }) {
  const issues = [];
  const modelQa = modelResult?.qa;
  if (!modelResult?.success) issues.push(issue('thumbnail-generation-unsuccessful', 'Hermes ne confirme pas la génération'));
  if (!modelQa || typeof modelQa !== 'object') {
    issues.push(issue('thumbnail-model-qa-missing', 'Auto-contrôle visuel Hermes absent'));
  } else {
    if (modelQa.finalAssetCount !== 1) issues.push(issue('thumbnail-asset-count-invalid', 'La réponse doit contenir un seul asset final'));
    const expectedText = normalizedText(draft?.bannerBrief?.headline);
    const observedText = normalizedText(modelQa.observedText);
    if (observedText !== expectedText || modelQa.textExact !== true) {
      issues.push(issue('thumbnail-text-mismatch', `Texte observé différent du texte attendu: ${observedText || '(vide)'}`));
    }
    if (modelQa.textClipped !== false) issues.push(issue('thumbnail-text-clipped', 'Texte rogné ou non vérifié'));
    if (modelQa.mobileReadable !== true) issues.push(issue('thumbnail-mobile-unreadable', 'Lisibilité mobile non confirmée'));
    for (const [field, code] of [['fakeLogo', 'thumbnail-fake-logo'], ['fakeInterface', 'thumbnail-fake-interface'], ['fakeFace', 'thumbnail-fake-face']]) {
      if (modelQa[field] !== false) issues.push(issue(code, `${field} présent ou non vérifié`));
    }
    issues.push(...brandedAssetIssues(modelQa, draft));
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
    const coverage = Number(inspection.paletteCoverage);
    if (!Number.isFinite(coverage) || coverage < MIN_PALETTE_COVERAGE || coverage > MAX_PALETTE_COVERAGE) {
      issues.push(issue('thumbnail-palette-coverage-invalid', `Couverture palette reçue: ${Number.isFinite(coverage) ? coverage.toFixed(3) : 'inconnue'}`));
    }
  }
  return {
    version: 1,
    policy: ARTICLE_THUMBNAIL_POLICY,
    checkedAt: new Date().toISOString(),
    passed: issues.length === 0,
    issueCodes: issues.map((entry) => entry.code),
    issues,
    inspection: inspection || null,
    modelQa: modelQa || null,
  };
}

export function thumbnailPublicationBlockers(draft) {
  if (draft?.contentType === 'video') return [];
  if (!['news', 'guide'].includes(draft?.contentType)) return ['thumbnail-content-type-unsupported'];
  const blockers = [];
  if (draft?.banner?.qa?.passed !== true) blockers.push('thumbnail-qa-failed');
  if (draft?.banner?.qa?.policy !== ARTICLE_THUMBNAIL_POLICY) blockers.push('thumbnail-policy-stale');
  if (draft?.banner?.width !== 1_280 || draft?.banner?.height !== 720) blockers.push('thumbnail-dimensions-invalid');
  if (extname(String(draft?.banner?.path || '')).toLowerCase() !== '.webp') blockers.push('thumbnail-format-invalid');
  return blockers;
}

export const THUMBNAIL_PALETTE_RANGE = Object.freeze({ min: MIN_PALETTE_COVERAGE, max: MAX_PALETTE_COVERAGE });
