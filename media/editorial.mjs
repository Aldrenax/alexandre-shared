import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { recommendedPublicationTime } from './publication-schedule.mjs';

const STYLE_GUIDE = readFileSync(
  fileURLToPath(new URL('../STYLE_GUIDE_BASE.md', import.meta.url)),
  'utf8',
);

export const CONTENT_REQUIREMENTS = Object.freeze({
  news: Object.freeze({ section: 'actualites', minimumWords: 1_200, maximumWords: 2_200 }),
  video: Object.freeze({ section: 'videos', minimumWords: 2_000, maximumWords: 4_500 }),
  guide: Object.freeze({ section: 'guides', minimumWords: 3_500, maximumWords: 7_500 }),
});

function sourcePacket(candidate) {
  return (candidate.sources || []).map((source, index) => ({
    ref: `S${index + 1}`,
    name: source.sourceId,
    official: Boolean(source.official),
    tier: source.tier,
    title: source.title,
    url: source.url,
    publishedAt: source.publishedAt,
    excerpt: String(source.excerpt || '').slice(0, 3_000),
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
      headline: '6 mots maximum ou chaîne vide',
      concept: 'description visuelle',
      alt: 'texte alternatif factuel',
      forbidden: ['logos inventés', 'chiffres non sourcés'],
    },
  };
}

function commonInstructions({ media, candidate, type, internalLinks, offer }) {
  const requirement = CONTENT_REQUIREMENTS[type];
  const sources = sourcePacket(candidate);
  return [
    `Tu rédiges pour ${media.name} (${media.siteUrl}).`,
    `Rubrique obligatoire: ${requirement.section}.`,
    `Longueur attendue: ${requirement.minimumWords} à ${requirement.maximumWords} mots utiles.`,
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
    `CONTEXTE VIDÉO JSON: ${JSON.stringify(context.video || null)}`,
  ];
  return [
    'ANGLE GUIDE:',
    '- Réponds exhaustivement à une intention durable et commerciale.',
    '- Inclus critères de choix, étapes, limites, erreurs, alternatives, tableau comparatif et FAQ.',
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

export function buildBannerPrompt({ media, draft }) {
  const brief = draft.bannerBrief || {};
  return [
    `Crée une bannière éditoriale professionnelle pour ${media.name}.`,
    'Format paysage 16:9, composition compatible avec un recadrage Open Graph 1200x630.',
    `Sujet: ${draft.title}`,
    `Concept: ${brief.concept || draft.description}`,
    `Texte visible: ${brief.headline || 'aucun texte'}`,
    'Style: crédible, éditorial, lisible sur mobile, fort contraste, sans esthétique publicitaire agressive.',
    'Interdictions: logo inventé, faux écran, faux chiffre, faux visage, marque déformée, petit texte illisible.',
    'Utilise l’outil image_gen avec aspect_ratio="landscape".',
    'Après génération, retourne le résultat sous ce schéma:',
    '{"success":true,"imageUrl":"URL retournée par image_gen","alt":"texte alternatif factuel","width":1200,"height":630}',
  ].join('\n');
}

export function normalizeDraft(payload, { contentType, candidate, media }) {
  if (payload?.status === 'blocked') return payload;
  const requirement = CONTENT_REQUIREMENTS[contentType];
  const body = String(payload?.body || '').trim();
  const wordCount = body.split(/\s+/).filter(Boolean).length;
  const generatedAt = new Date();
  return {
    ...payload,
    status: 'draft',
    contentType,
    section: requirement.section,
    mediaSlug: media.slug,
    candidateId: candidate.id,
    title: String(payload?.title || '').trim(),
    slug: String(payload?.slug || '').trim(),
    description: String(payload?.description || '').trim().slice(0, 180),
    body,
    wordCount,
    sourceUrls: [...new Set((payload?.sourceUrls || []).filter((url) => /^https?:\/\//.test(url)))],
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
