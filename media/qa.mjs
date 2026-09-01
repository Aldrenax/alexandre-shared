import { existsSync, statSync } from 'node:fs';
import { SOURCE_POLICY_AUTHOR_VIEWS } from '../config/source-policies.mjs';
import { CONTENT_REQUIREMENTS } from './editorial.mjs';
import { thumbnailPublicationBlockers } from './thumbnail-qa.mjs';

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
  if (!['news', 'guide'].includes(draft.contentType)) return [];
  if (draft.banner.qa?.passed !== true) return [
    issue('thumbnail-qa-failed', 'La miniature générée n’a pas passé la QA visuelle'),
    ...(draft.banner.qa?.issues || []).map((entry) => issue(entry.code || 'thumbnail-qa-issue', entry.message || 'Échec QA miniature')),
  ];
  return [];
}

const AUTHOR_VIEWS_RESERVE = 'Cette analyse reflète le point de vue de ses auteurs et ne constitue pas une position officielle de la BCE.';
const AUTHOR_ROLE = /(?<![\p{L}\p{N}_])(?:auteurs?|économistes?|chercheurs?|signataires?)(?![\p{L}\p{N}_])/iu;
const AUTHOR_IDENTITY = /(?<![\p{L}\p{N}_])(?:auteurs?|économistes?|chercheurs?|signataires?)(?![\p{L}\p{N}_])[^.\n]{0,100}\b(?:BCE|Banque\s+centrale\s+européenne)\b|\b(?:BCE|Banque\s+centrale\s+européenne)\b[^.\n]{0,100}(?<![\p{L}\p{N}_])(?:auteurs?|économistes?|chercheurs?|signataires?)(?![\p{L}\p{N}_])/iu;
const AUTHOR_ANALYSIS_VERB = /\b(?:analys(?:e|ent)|estim(?:e|ent)|attribu(?:e|ent)|considèr(?:e|ent)|jug(?:e|ent)|conclu(?:t|ent)|prévoi(?:t|ent)|anticip(?:e|ent)|affirm(?:e|ent)|expliqu(?:e|ent)|observ(?:e|ent)|constat(?:e|ent)|identifi(?:e|ent)|reli(?:e|ent)|imput(?:e|ent)|soutien(?:t|nent)|averti(?:t|ssent)|préconis(?:e|ent)|précis(?:e|ent)|indiqu(?:e|ent)|décri(?:t|vent)|insist(?:e|ent)|oppos(?:e|ent)|écri(?:t|vent)|soulign(?:e|ent)|avanc(?:e|ent))\b/iu;
const ANALYTICAL_ASSERTION = /\b(?:estim(?:e|ent)|attribu(?:e|ent)|considèr(?:e|ent)|jug(?:e|ent)|conclu(?:t|ent)|prévoi(?:t|ent)|anticip(?:e|ent)|affirm(?:e|ent)|expliqu(?:e|ent)|identifi(?:e|ent)|reli(?:e|ent)|imput(?:e|ent)|soutien(?:t|nent)|averti(?:t|ssent)|préconis(?:e|ent)|soulign(?:e|ent)|avanc(?:e|ent)|résult(?:e|ent)|entraîn(?:e|ent)|caus(?:e|ent)|découl(?:e|ent)|(?:est|sont)\s+li(?:é|ée|és|ées))\b/iu;
const INSTITUTIONAL_ATTRIBUTION = /\b(?:(?:la\s+)?(?:BCE|Banque\s+centrale\s+européenne|banque\s+centrale)|l['’]institution)\s+(?:pointe|estime|attribue|considère|juge|analyse|conclut|prévoit|anticipe|affirme|explique|observe|constate|identifie|relie|impute|soutient|avertit|préconise|précise|indique|décrit|insiste|oppose|voit|déclare|assure|avance|table|redoute|recommande|propose|évalue|annonce|a\s+(?:pointé|estimé|attribué|considéré|jugé|analysé|conclu|prévu|anticipé|affirmé|expliqué|observé|constaté|identifié|relié|imputé|soutenu|averti|préconisé|précisé|indiqué|décrit|insisté|opposé|déclaré|assuré|avancé|redouté|recommandé|proposé|évalué|annoncé))\b|\b(?:pour|selon|d['’]après|du\s+point\s+de\s+vue\s+de)\s+(?:la\s+)?(?:BCE|Banque\s+centrale\s+européenne|banque\s+centrale)\b|\b(?:la\s+)?position\s+(?:officielle\s+)?de\s+la\s+(?:BCE|Banque\s+centrale\s+européenne)\s+(?:est|serait|reste)\b/giu;
const NEGATED_INSTITUTIONAL_ATTRIBUTION = /(?:(?:faux|erroné|erronée|inexact|inexacte|incorrect|incorrecte)\s+(?:de\s+)?(?:dire|affirmer|écrire|prétendre)\s+que|ne\s+(?:faut|doit)\s+pas\s+(?:dire|affirmer|écrire|prétendre)\s+que)\s*$/iu;

function normalizeComparableText(value = '') {
  return String(value)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function proseSegments(value = '') {
  return String(value)
    .split(/[.!?]\s+|\n+|;\s*/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function publicDraftText(draft = {}) {
  return [
    draft.title,
    draft.description,
    draft.body,
    draft.category,
    draft.topic,
    ...(draft.tags || []),
    ...(draft.keyPoints || []),
    ...(draft.faq || []).flatMap((entry) => [entry?.question, entry?.answer]),
    ...(draft.internalLinkSuggestions || []).map((entry) => entry?.anchor),
    draft.bannerBrief?.headline,
    draft.bannerBrief?.concept,
    draft.bannerBrief?.alt,
    draft.banner?.alt,
  ].filter((value) => typeof value === 'string' && value.trim());
}

function containsInstitutionalAttribution(value = '') {
  for (const match of String(value).matchAll(INSTITUTIONAL_ATTRIBUTION)) {
    const prefix = String(value).slice(Math.max(0, Number(match.index || 0) - 100), match.index);
    if (!NEGATED_INSTITUTIONAL_ATTRIBUTION.test(prefix)) return true;
  }
  return false;
}

function containsAuthorAttribution(value = '', namedAuthors = [], { requireInstitutionalIdentity = true } = {}) {
  const text = String(value);
  if (!AUTHOR_ANALYSIS_VERB.test(text)) return false;
  if (AUTHOR_IDENTITY.test(text)) return true;
  const normalized = normalizeComparableText(text);
  const namesAuthor = namedAuthors.some((author) => {
    const name = normalizeComparableText(author);
    return name.length >= 5 && normalized.includes(name);
  });
  if (namesAuthor) return true;
  return !requireInstitutionalIdentity && AUTHOR_ROLE.test(text);
}

function segmentSupportedByClaim(segment, claims) {
  const normalizedSegment = normalizeComparableText(segment);
  if (normalizedSegment.length < 12) return false;
  return claims.some((claim) => {
    const normalizedClaim = normalizeComparableText(claim?.statement);
    return normalizedClaim.length >= 20
      && (normalizedSegment.includes(normalizedClaim) || normalizedClaim.includes(normalizedSegment));
  });
}

function authorViewsIssues(draft, candidate) {
  const sources = candidate?.sources || [];
  const authorViewRefs = new Set(sources
    .map((source, index) => source?.sourcePolicy === SOURCE_POLICY_AUTHOR_VIEWS ? `S${index + 1}` : null)
    .filter(Boolean));
  if (!authorViewRefs.size) return [];

  const knownRefs = new Set(sources.map((_, index) => `S${index + 1}`));
  const claims = Array.isArray(draft?.claims) ? draft.claims : [];
  const authorViewClaims = claims.filter((claim) => (claim?.sourceRefs || []).some((ref) => authorViewRefs.has(ref)));
  const nonAuthorViewClaims = claims.filter((claim) => Array.isArray(claim?.sourceRefs)
    && claim.sourceRefs.length > 0
    && claim.sourceRefs.every((ref) => knownRefs.has(ref) && !authorViewRefs.has(ref)));
  const namedAuthors = sources
    .filter((source) => source?.sourcePolicy === SOURCE_POLICY_AUTHOR_VIEWS)
    .map((source) => source?.author)
    .filter(Boolean);
  const publicText = publicDraftText(draft)
    .map((value) => value.split(AUTHOR_VIEWS_RESERVE).join(' '));
  const publicSegments = publicText.flatMap(proseSegments);
  const issues = [];

  const invalidAuthorViewClaim = authorViewClaims.some((claim) => containsInstitutionalAttribution(claim?.statement));
  const invalidPublicAttribution = publicSegments.some((segment) => containsInstitutionalAttribution(segment)
    && !segmentSupportedByClaim(segment, nonAuthorViewClaims));
  if (invalidAuthorViewClaim || invalidPublicAttribution) {
    issues.push(issue(
      'author-views-institutional-attribution',
      'Une analyse signée ne peut pas être attribuée à la BCE comme position institutionnelle; attribuer les conclusions aux auteurs',
    ));
  }

  const analyticalAuthorViewClaims = authorViewClaims
    .filter((claim) => ANALYTICAL_ASSERTION.test(String(claim?.statement || '')));
  const publicAttributionPresent = publicSegments.some((segment) => containsAuthorAttribution(segment, namedAuthors));
  const authorViewClaimsAttributed = analyticalAuthorViewClaims
    .every((claim) => containsAuthorAttribution(claim?.statement, namedAuthors, { requireInstitutionalIdentity: false }));
  if (analyticalAuthorViewClaims.length > 0 && (!publicAttributionPresent || !authorViewClaimsAttributed)) {
    issues.push(issue(
      'author-views-attribution-missing',
      'L’analyse doit être attribuée explicitement aux auteurs ou économistes du billet publié par la BCE',
    ));
  }
  if (!String(draft?.body || '').includes(AUTHOR_VIEWS_RESERVE)) {
    issues.push(issue(
      'author-views-reserve-missing',
      'Ajouter explicitement que l’analyse reflète le point de vue de ses auteurs et ne constitue pas une position officielle de la BCE',
    ));
  }
  return issues;
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

  issues.push(...authorViewsIssues(draft, candidate));
  issues.push(...complianceIssues(draft, media));
  issues.push(...bannerIssues(draft, { requireBanner }));
  const errors = issues.filter((entry) => entry.severity === 'error');
  return {
    version: 2,
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
  blockers.push(...thumbnailPublicationBlockers(draft));
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
