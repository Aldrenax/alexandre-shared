import { existsSync, statSync } from 'node:fs';
import { CONTENT_REQUIREMENTS } from './editorial.mjs';

function issue(code, message, severity = 'error') {
  return { code, message, severity };
}

function markdownLinks(body = '') {
  return [...String(body).matchAll(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/g)].map((match) => match[1]);
}

function complianceIssues(draft, media) {
  const body = String(draft.body || '').toLowerCase();
  const issues = [];
  if (media.risk === 'regulated-finance') {
    if (!/ne constitu(?:e|ent) pas (?:un )?conseil en investissement/.test(body)) issues.push(issue('finance-disclaimer-missing', 'Disclaimer conseil en investissement manquant'));
    if (!/(?:risque de perte en capital|perte (?:partielle ou totale|totale ou partielle) du capital)/.test(body)) issues.push(issue('capital-risk-missing', 'Mention du risque de perte en capital manquante'));
  }
  if (media.risk === 'legal-tax') {
    if (!/ne constitu(?:e|ent) pas (?:un )?conseil (?:juridique|fiscal)/.test(body)) {
      issues.push(issue('legal-tax-disclaimer-missing', 'Disclaimer juridique ou fiscal personnalisé manquant'));
    }
  }
  if (draft.offer && !body.includes('affili')) issues.push(issue('affiliate-disclosure-missing', 'Mention d’affiliation manquante'));
  if (draft.offer?.url && !String(draft.body || '').includes(`](${draft.offer.url})`)) {
    issues.push(issue('affiliate-link-missing', 'Lien de l’offre validée manquant'));
  }
  return issues;
}

function bannerIssues(draft, { requireBanner }) {
  if (!requireBanner) return [];
  if (!draft.banner?.path) return [issue('banner-missing', 'Bannière obligatoire absente')];
  if (!existsSync(draft.banner.path)) return [issue('banner-file-missing', `Fichier bannière introuvable: ${draft.banner.path}`)];
  const size = statSync(draft.banner.path).size;
  if (size < 8_000) return [issue('banner-too-small', `Bannière anormalement petite: ${size} octets`)];
  if (!draft.banner.alt?.trim()) return [issue('banner-alt-missing', 'Texte alternatif de bannière manquant')];
  return [];
}

export function qaDraft(draft, media, {
  candidate = null,
  requireBanner = true,
  now = new Date(),
} = {}) {
  const issues = [];
  const requirement = CONTENT_REQUIREMENTS[draft?.contentType];
  if (!requirement) issues.push(issue('content-type-invalid', `Type de contenu invalide: ${draft?.contentType}`));
  if (!draft?.title?.trim()) issues.push(issue('title-missing', 'Titre manquant'));
  const titleLimit = draft?.contentType === 'video' ? 120 : 80;
  if ((draft?.title || '').length > titleLimit) issues.push(issue('title-too-long', `Titre supérieur à ${titleLimit} caractères`));
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft?.slug || '')) issues.push(issue('slug-invalid', 'Slug kebab-case invalide'));
  if (!draft?.description?.trim() || draft.description.length > 180) issues.push(issue('description-invalid', 'Meta description absente ou supérieure à 180 caractères'));
  if (!draft?.body?.trim()) issues.push(issue('body-missing', 'Corps Markdown manquant'));
  if (/^#\s+/m.test(draft?.body || '')) issues.push(issue('h1-forbidden', 'Le corps ne doit pas contenir de H1'));
  if (/[—–]/.test(`${draft?.title || ''}\n${draft?.body || ''}`)) issues.push(issue('typography-dash', 'Tiret cadratin ou demi-cadratin interdit'));

  if (requirement) {
    if (draft.section !== requirement.section) issues.push(issue('section-invalid', `Rubrique attendue: ${requirement.section}`));
    if (Number(draft.wordCount) < requirement.minimumWords) issues.push(issue('word-count-low', `${requirement.minimumWords} mots minimum, ${draft.wordCount || 0} reçus`));
    if (Number(draft.wordCount) > requirement.maximumWords) issues.push(issue('word-count-high', `${requirement.maximumWords} mots maximum, ${draft.wordCount || 0} reçus`, 'warning'));
  }
  if (draft?.contentType === 'news' && !media.newsCategories?.includes(draft.category)) issues.push(issue('category-invalid', `Catégorie actualité invalide: ${draft.category}`));
  if (draft?.contentType === 'guide' && !media.guideTopics?.includes(draft.topic || draft.category)) issues.push(issue('guide-topic-invalid', `Sujet de guide invalide: ${draft.topic || draft.category}`));

  const sourceUrls = new Set(draft?.sourceUrls || []);
  if (!sourceUrls.size) issues.push(issue('sources-missing', 'Aucune source déclarée'));
  const links = markdownLinks(draft?.body);
  if (![...sourceUrls].some((url) => links.includes(url))) issues.push(issue('source-link-missing', 'Aucune source déclarée n’est citée dans le corps'));

  const validRefs = new Set((candidate?.sources || []).map((_, index) => `S${index + 1}`));
  if (!Array.isArray(draft?.claims) || !draft.claims.length) {
    issues.push(issue('claims-missing', 'Registre des affirmations factuelles manquant'));
  } else {
    for (const [index, claim] of draft.claims.entries()) {
      if (!claim?.statement?.trim()) issues.push(issue('claim-empty', `Affirmation ${index + 1} vide`));
      if (!Array.isArray(claim?.sourceRefs) || !claim.sourceRefs.length) issues.push(issue('claim-unsourced', `Affirmation ${index + 1} non sourcée`));
      for (const ref of claim?.sourceRefs || []) {
        if (validRefs.size && !validRefs.has(ref)) issues.push(issue('claim-source-unknown', `Référence de source inconnue: ${ref}`));
      }
    }
  }

  if (candidate?.status !== 'qualified') issues.push(issue('candidate-not-qualified', 'Le candidat éditorial n’est pas qualifié'));
  if (candidate?.corroborated === false) issues.push(issue('candidate-not-corroborated', 'Le candidat n’est pas corroboré'));
  if (candidate?.rumor) issues.push(issue('rumor-blocked', 'Une rumeur ne peut pas être publiée automatiquement'));

  issues.push(...complianceIssues(draft, media));
  issues.push(...bannerIssues(draft, { requireBanner }));
  const errors = issues.filter((entry) => entry.severity === 'error');
  return {
    version: 1,
    checkedAt: now.toISOString(),
    mediaSlug: media.slug,
    candidateId: draft?.candidateId || candidate?.id || null,
    passed: errors.length === 0,
    errorCount: errors.length,
    warningCount: issues.length - errors.length,
    issues,
  };
}

export function publicationDecision({
  draft,
  qa,
  media,
  publicationMode = 'draft',
  explicitApproval = false,
  shadowDays = 0,
  shadowDaysRequired = 7,
  now = new Date(),
}) {
  const blockers = [];
  if (!qa?.passed) blockers.push('qa-failed');
  if (publicationMode !== 'automatic') blockers.push('publication-mode-not-automatic');
  if (!explicitApproval) blockers.push('automatic-publication-not-approved');
  if (shadowDays < shadowDaysRequired) blockers.push(`shadow-period-${shadowDays}/${shadowDaysRequired}`);
  if (draft?.publicationMode !== 'draft') blockers.push('draft-state-invalid');
  if (!media?.editorialEnabled) blockers.push('media-editorial-paused');
  if (draft?.scheduledPublishAt && Date.parse(draft.scheduledPublishAt) > now.getTime()) {
    blockers.push(`scheduled-for-${draft.scheduledPublishAt}`);
  }
  return {
    allowed: blockers.length === 0,
    blockers,
    action: blockers.length ? 'keep-draft' : 'schedule',
  };
}
