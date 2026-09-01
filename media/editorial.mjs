import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { recommendedPublicationTime } from './publication-schedule.mjs';
import {
  ARTICLE_THUMBNAIL_POLICY,
  articleThumbnailProfile,
  officialThumbnailAssets,
} from './thumbnail-policy.mjs';

const STYLE_GUIDE = readFileSync(
  fileURLToPath(new URL('../STYLE_GUIDE_BASE.md', import.meta.url)),
  'utf8',
);

export const CONTENT_REQUIREMENTS = Object.freeze({
  news: Object.freeze({ section: 'actualites', minimumWords: 1_200, maximumWords: 2_200 }),
  video: Object.freeze({ section: 'videos', minimumWords: 2_000, maximumWords: 4_500 }),
  guide: Object.freeze({ section: 'guides', minimumWords: 3_500, maximumWords: 7_500 }),
});

export const EDITORIAL_REVISION = 13;
export { ARTICLE_THUMBNAIL_POLICY, articleThumbnailProfile } from './thumbnail-policy.mjs';

function thumbnailDirection(draft) {
  const text = `${draft?.title || ''} ${draft?.description || ''}`.toLowerCase();
  if (/piege|piège|attention|risque|arnaque|erreur|limite|rappel|danger/.test(text)) return 'Trap / Truth';
  if (draft?.contentType === 'guide') return 'Proof / Result';
  return 'SEO Direct';
}

function normalizedSlug(value, fallback = '') {
  return String(value || fallback)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160)
    .replace(/-+$/g, '');
}

function sourcePacket(candidate, maximumExcerptLength = 3_000) {
  return (candidate.sources || []).map((source, index) => ({
    ref: `S${index + 1}`,
    name: source.sourceId,
    official: Boolean(source.official),
    tier: source.tier,
    title: source.title,
    url: source.url,
    publishedAt: source.publishedAt,
    excerpt: String(source.excerpt || '').slice(0, maximumExcerptLength),
  }));
}

function outputSchema(type) {
  const requirement = CONTENT_REQUIREMENTS[type];
  return {
    contentType: type,
    section: requirement.section,
    title: 'string',
    slug: 'string-kebab-case',
    description: 'string <= 180 caractères',
    body: 'Markdown complet sans H1',
    wordCount: 0,
    category: 'string',
    tags: ['string'],
    keyPoints: ['string'],
    faq: [{ question: 'string', answer: 'string' }],
    sourceUrls: ['https://...'],
    claims: [{ statement: 'string', sourceRefs: ['S1'] }],
    internalLinkSuggestions: [{ anchor: 'string', path: '/...' }],
    offer: null,
    bannerBrief: {
      headline: '2 à 4 mots maximum ou chaîne vide',
      concept: 'description visuelle',
      alt: 'texte alternatif factuel',
      forbidden: ['logos inventés', 'chiffres non sourcés'],
    },
  };
}

function complianceInstructions(media) {
  if (media.risk === 'regulated-finance') return [
    'CONFORMITÉ FINANCIÈRE OBLIGATOIRE:',
    '- Ajoute une section d’avertissement clairement visible dans le body.',
    '- Inclus exactement cette phrase: "Ce contenu ne constitue pas un conseil en investissement."',
    '- Inclus exactement cette phrase: "Tout investissement comporte un risque de perte en capital, partielle ou totale."',
  ];
  if (media.risk === 'legal-tax') return [
    'CONFORMITÉ JURIDIQUE ET FISCALE OBLIGATOIRE:',
    '- Ajoute une section d’avertissement clairement visible dans le body.',
    '- Inclus exactement cette phrase: "Ce contenu ne constitue pas un conseil juridique ou fiscal personnalisé."',
  ];
  return [];
}

function commonInstructions({ media, candidate, type, internalLinks, offer }) {
  const requirement = CONTENT_REQUIREMENTS[type];
  // Leave a deliberate margin for model-side word-count drift. The QA floor
  // remains the publication gate; this target simply prevents near-miss drafts.
  const wordTarget = requirement.minimumWords + ({ news: 150, video: 250, guide: 400 }[type] || 0);
  const sources = sourcePacket(candidate, type === 'guide' ? 12_000 : 3_000);
  return [
    `Tu rédiges pour ${media.name} (${media.siteUrl}).`,
    `Rubrique obligatoire: ${requirement.section}.`,
    `Longueur attendue: ${requirement.minimumWords} à ${requirement.maximumWords} mots utiles.`,
    `Objectif de sécurité: vise au moins ${wordTarget} mots utiles afin de ne jamais descendre sous le seuil QA de ${requirement.minimumWords} mots après normalisation.`,
    `Risque éditorial: ${media.risk}.`,
    '',
    'RÈGLES DE PREUVE:',
    '- Utilise uniquement les faits contenus dans le paquet de sources.',
    '- Chaque chiffre, date, citation, annonce, obligation ou caractéristique sensible doit apparaître dans claims avec au moins une sourceRef.',
    '- Distingue explicitement fait, analyse et opinion.',
    '- Cite les sources dans le body avec des liens Markdown directs.',
    '- Une source X non officielle ne suffit jamais à confirmer un fait.',
    '- Si les sources ne permettent pas un article exact et utile, retourne {"status":"blocked","reason":"..."}.',
    '',
    'RÈGLES ÉDITORIALES:',
    STYLE_GUIDE,
    '',
    'BRIEF ÉDITORIAL SPÉCIFIQUE AU SITE:',
    media.editorialBrief || 'Aucun brief spécifique disponible.',
    '',
    ...complianceInstructions(media),
    '',
    `MÉDIA JSON: ${JSON.stringify({
      slug: media.slug,
      keywords: media.topicKeywords,
      newsCategories: media.newsCategories,
      guideTopics: media.guideTopics,
    })}`,
    `CANDIDAT JSON: ${JSON.stringify({ id: candidate.id, title: candidate.title, score: candidate.score, keywordMatches: candidate.keywordMatches })}`,
    `SOURCES JSON: ${JSON.stringify(sources)}`,
    `LIENS INTERNES DISPONIBLES JSON: ${JSON.stringify(internalLinks || [])}`,
    `OFFRE VALIDÉE JSON: ${JSON.stringify(offer || null)}`,
    '',
    'Si une offre validée est fournie, intègre-la discrètement et indique clairement le caractère affilié. N’ajoute aucune autre offre ni URL commerciale.',
    `SCHÉMA JSON ATTENDU: ${JSON.stringify(outputSchema(type))}`,
  ];
}

function typeInstructions(type, context) {
  if (type === 'news') return [
    'ANGLE ACTUALITÉ:',
    '- Explique ce qui vient de changer, ce qui est confirmé et ce qui reste inconnu.',
    '- Apporte une conséquence pratique pour le lecteur, sans paraphraser la source.',
    '- Ne transforme pas une absence de nouveauté qualifiée en article de remplissage.',
  ];
  if (type === 'video') return [
    'ANGLE VIDÉO:',
    '- Le titre doit reprendre exactement le titre YouTube fourni dans le contexte vidéo.',
    '- Transforme la transcription complète en article autonome et structuré.',
    '- Intègre la vidéo en introduction et conserve les idées réellement exprimées.',
    '- N’invente ni test, ni expérience, ni résultat absent de la vidéo.',
    '- La vidéo est la source primaire de cette adaptation: un fait sensible non corroboré doit être attribué explicitement à la vidéo avec une formulation comme « dans la vidéo, je présente » ou « selon la vidéo », jamais présenté comme une règle confirmée.',
    '- L’absence de source externe ne suffit pas, à elle seule, à bloquer une adaptation fidèle de la vidéo. Ajoute les réserves et avertissements requis, invite le lecteur à vérifier sa situation auprès d’une source officielle et bloque seulement si la transcription ne permet pas une restitution exacte.',
    `CONTEXTE VIDÉO JSON: ${JSON.stringify(context.video || null)}`,
  ];
  return [
    'ANGLE GUIDE:',
    '- Réponds exhaustivement à une intention durable et commerciale.',
    '- Inclus critères de choix, étapes, limites, erreurs, tableau récapitulatif et FAQ.',
    '- Ne compare des alternatives que si le paquet de sources les documente précisément.',
    '- L’offre est une recommandation contextualisée, pas le prétexte du guide.',
    '- Signale clairement ce qui doit être revérifié périodiquement.',
  ];
}

export function buildEditorialPrompt({
  media,
  candidate,
  contentType = 'news',
  internalLinks = [],
  offer = candidate?.offer || null,
  video = null,
}) {
  if (!CONTENT_REQUIREMENTS[contentType]) throw new Error(`contentType inconnu: ${contentType}`);
  return [
    ...commonInstructions({ media, candidate, type: contentType, internalLinks, offer }),
    '',
    ...typeInstructions(contentType, { video }),
  ].join('\n');
}

export function buildEditorialRepairPrompt({ media, candidate, contentType, draft, qa }) {
  const requirement = CONTENT_REQUIREMENTS[contentType];
  if (!requirement) throw new Error(`contentType inconnu: ${contentType}`);
  const repairTarget = requirement.minimumWords + ({ news: 150, video: 250, guide: 400 }[contentType] || 0);
  const editableDraft = {
    contentType,
    section: draft.section,
    title: draft.title,
    slug: draft.slug,
    description: draft.description,
    body: draft.body,
    wordCount: draft.wordCount,
    category: draft.category,
    topic: draft.topic,
    tags: draft.tags,
    keyPoints: draft.keyPoints,
    faq: draft.faq,
    sourceUrls: draft.sourceUrls,
    claims: draft.claims,
    internalLinkSuggestions: draft.internalLinkSuggestions,
    offer: draft.offer,
    bannerBrief: draft.bannerBrief,
  };
  return [
    `RÉPARATION QA BORNÉE pour ${media.name}.`,
    `Corrige uniquement les erreurs QA listées ci-dessous et retourne le brouillon complet au format JSON.`,
    `Seuil de longueur: ${requirement.minimumWords} à ${requirement.maximumWords} mots; vise au moins ${repairTarget} mots utiles si le brouillon est trop court.`,
    contentType === 'video' ? `Le titre doit rester exactement: ${candidate.title}` : null,
    '',
    'GARDE-FOUS:',
    '- Conserve les faits, la position éditoriale, les URL sources, les claims et les références valides.',
    '- N’ajoute aucun fait, chiffre, citation, test, résultat, offre ou URL qui ne figure pas déjà dans le brouillon.',
    '- Pour allonger, développe uniquement les explications, transitions, limites et conséquences déjà présentes.',
    '- Pour raccourcir, retire les répétitions sans supprimer les preuves ni les avertissements.',
    '- N’utilise aucun H1 et aucun tiret cadratin ou demi-cadratin.',
    `ERREURS QA JSON: ${JSON.stringify(qa?.issues || [])}`,
    `BROUILLON À RÉPARER JSON: ${JSON.stringify(editableDraft)}`,
    `SCHÉMA JSON ATTENDU: ${JSON.stringify(outputSchema(contentType))}`,
  ].filter(Boolean).join('\n');
}

export function buildBannerPrompt({ media, draft }) {
  const brief = draft.bannerBrief || {};
  const profile = articleThumbnailProfile(media);
  const officialAssets = officialThumbnailAssets(draft);
  return [
    `Apply the visual principles of the youtube-thumbnail-imagegen skill. Policy: ${ARTICLE_THUMBNAIL_POLICY}.`,
    `Create EXACTLY ONE professional article thumbnail for ${media.name}; no variants and no second image.`,
    'Landscape 16:9, final output 1280x720, immediately legible on a small mobile card.',
    `Topic: ${draft.title}`,
    `Concept: ${brief.concept || draft.description}`,
    `Direction: ${thumbnailDirection(draft)}.`,
    `Channel palette: ${profile.palette}.`,
    `Tone: ${profile.tone}.`,
    'The channel color must cover 60-70% of the image through the background, surfaces, lighting or a bright gradient. White and black are contrast neutrals, never the dominant canvas.',
    `Exact visible French text: ${brief.headline || 'NO TEXT'}. If present it must be 2-4 words, uppercase, mobile-safe, fully inside generous safe margins, never clipped.`,
    'Composition: one dominant element, at most one secondary clue, and at most one text block.',
    'Use a concrete generic unbranded object or abstract technical symbol. Never invent an interface, screen, logo, brand mark or person.',
    `Official reusable asset allowlist (empty means none): ${JSON.stringify(officialAssets)}.`,
    'A logo, product interface, dashboard, screenshot or face may appear ONLY when its exact official reference asset is listed above. Otherwise replace it with a generic unbranded object.',
    'Typography if text exists: condensed bold capitals, white or yellow, thick black outline. High contrast, clean background, no dense dashboard.',
    'Forbidden: multiple central ideas, small text, invented or approximate logo, fake screen/interface, deformed brand, invented face, unsourced number, price, yield, statistic or promise.',
    'Use image_gen with aspect_ratio="landscape" exactly once.',
    'After generation, visually inspect that single result and copy its exact `image` value to `imageSource`.',
    'Return JSON only. Every qa field is mandatory; if it cannot be verified, set success=false.',
    '{"success":true,"imageSource":"exact image value","alt":"factual alt","width":1280,"height":720,"qa":{"finalAssetCount":1,"paletteCoverage":0.65,"observedText":"EXACT TEXT OR EMPTY","textExact":true,"textClipped":false,"mobileReadable":true,"usesLogo":false,"usesInterface":false,"usesFace":false,"assetSources":[],"fakeLogo":false,"fakeInterface":false,"fakeFace":false}}',
  ].join('\n');
}

export function buildBannerRepairPrompt({ media, draft, issues, attempt }) {
  return [
    buildBannerPrompt({ media, draft }),
    '',
    `CORRECTIVE ATTEMPT ${attempt}. The previous single result failed QA.`,
    `Fix only these visual QA failures: ${JSON.stringify(issues || [])}.`,
    'Generate exactly one new replacement image in this attempt, inspect it, and return the same complete JSON schema. Do not return or reuse the rejected asset.',
  ].join('\n');
}

export function normalizeDraft(payload, { contentType, candidate, media }) {
  if (payload?.status === 'blocked') return payload;
  const requirement = CONTENT_REQUIREMENTS[contentType];
  const candidateSourceUrls = (candidate.sources || [])
    .map((source) => source.url)
    .filter((url) => /^https?:\/\//.test(url || ''));
  const sourceUrls = [...new Set([
    ...(payload?.sourceUrls || []).filter((url) => /^https?:\/\//.test(url)),
    ...candidateSourceUrls,
  ])];
  const sourceItemIds = [...new Set((candidate.sources || [])
    .filter((source) => source?.kind === 'official-api' && source?.sourceId && source?.itemId != null)
    .map((source) => `${source.sourceId}:${source.itemId}`))];
  let body = String(payload?.body || '').trim();
  if (contentType === 'video' && candidate.primaryUrl && !body.includes(`](${candidate.primaryUrl})`)) {
    body = `> [Voir la vidéo originale](${candidate.primaryUrl})\n\n${body}`;
  }
  if (contentType === 'video' && candidate.offer?.url && !body.includes(`](${candidate.offer.url})`)) {
    body = `> [Découvrir ${candidate.offer.name} via mon lien affilié](${candidate.offer.url})\n\n${body}`;
  }
  if (sourceUrls.length && !sourceUrls.some((url) => body.includes(`](${url})`))) {
    const references = sourceUrls.slice(0, 4).map((url, index) => `- [Source ${index + 1}](${url})`).join('\n');
    body = `${body}\n\n## Sources\n\n${references}`;
  }
  const wordCount = body.split(/\s+/).filter(Boolean).length;
  const generatedAt = new Date();
  const sourcePublishedAt = [
    candidate.publishedAt,
    ...(candidate.sources || []).map((source) => source?.publishedAt),
  ].find((value) => Number.isFinite(Date.parse(value || ''))) || null;
  return {
    ...payload,
    status: 'draft',
    contentType,
    section: requirement.section,
    mediaSlug: media.slug,
    candidateId: candidate.id,
    title: String(payload?.title || '').trim(),
    slug: normalizedSlug(payload?.slug, payload?.title || candidate.title),
    description: String(payload?.description || '').trim().slice(0, 180),
    body,
    wordCount,
    sourceUrls,
    sourceItemIds,
    sourcePublishedAt,
    candidateQualification: {
      profile: candidate.qualificationProfile || 'strict',
      score: Number(candidate.score || 0),
      maxAgeHours: Number(candidate.maxAgeHours || 0),
      officialRequired: Boolean(candidate.officialRequired),
      corroborated: Boolean(candidate.corroborated),
    },
    offer: candidate.offer || null,
    claims: Array.isArray(payload?.claims) ? payload.claims : [],
    generatedAt: generatedAt.toISOString(),
    scheduledPublishAt: recommendedPublicationTime(contentType, {
      now: generatedAt,
      startHour: Number(process.env.MEDIA_ENGINE_PUBLISH_START_HOUR || 7),
      endHour: Number(process.env.MEDIA_ENGINE_PUBLISH_END_HOUR || 21),
    }).toISOString(),
    publicationMode: 'draft',
  };
}
