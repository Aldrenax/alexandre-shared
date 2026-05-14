/**
 * Builders de schemas Schema.org pour les sites Alexandre Chaimbault.
 *
 * Cette version est factorisée : chaque builder accepte un `siteConfig` qui contient
 * les infos site-specific (url, shortName, author...). Les sites Invest/Tesla
 * fournissent leur propre `SITE` via `channel.config.mjs` ou `src/lib/site.ts`.
 *
 * Usage (Astro) :
 *   import { buildArticleSchema } from 'alexandre-shared/lib/seo.mjs';
 *   import { SITE } from '../lib/site';
 *   const json = buildArticleSchema({ title, description, ... }, SITE);
 *
 * `siteConfig` est un objet avec au minimum :
 *   - url: string                                   // 'https://alexandre-investissement.fr'
 *   - shortName: string                             // 'Alexandre · Investissement'
 *   - name: string                                  // 'Alexandre · Finance & Investissement'
 *   - description: string                           // 'site description'
 *   - defaultOgImage: string                        // '/og-default.png'
 *   - author: {
 *       name: string,
 *       role: string,
 *       avatar: string,
 *       sameAs: string[],
 *     }
 */

export function buildArticleSchema(a, siteConfig) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: a.title,
    description: a.description,
    image: a.image ?? `${siteConfig.url}${siteConfig.defaultOgImage}`,
    datePublished: new Date(a.datePublished).toISOString(),
    dateModified: new Date(a.dateModified ?? a.datePublished).toISOString(),
    author: {
      '@type': 'Person',
      name: a.authorName ?? siteConfig.author.name,
      url: siteConfig.url + '/a-propos/',
    },
    publisher: {
      '@type': 'Organization',
      name: siteConfig.shortName,
      logo: {
        '@type': 'ImageObject',
        url: `${siteConfig.url}/logo.png`,
      },
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': a.url },
    ...(a.wordCount ? { wordCount: a.wordCount } : {}),
    ...(a.category ? { articleSection: a.category } : {}),
    ...(a.keywords?.length ? { keywords: a.keywords.join(', ') } : {}),
    inLanguage: 'fr-FR',
  };
}

export function buildVideoSchema(v, siteConfig) {
  return {
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: v.title,
    description: v.description,
    thumbnailUrl: v.thumbnailUrl,
    uploadDate: new Date(v.uploadDate).toISOString(),
    contentUrl: `https://www.youtube.com/watch?v=${v.videoId}`,
    embedUrl: `https://www.youtube.com/embed/${v.videoId}`,
    ...(v.duration ? { duration: v.duration } : {}),
    publisher: {
      '@type': 'Organization',
      name: siteConfig.shortName,
      logo: { '@type': 'ImageObject', url: `${siteConfig.url}/logo.png` },
    },
    inLanguage: 'fr-FR',
  };
}

export function buildBreadcrumbSchema(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  };
}

export function buildFaqSchema(faq) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map((f) => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer },
    })),
  };
}

export function buildPersonSchema(siteConfig) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: siteConfig.author.name,
    jobTitle: siteConfig.author.role,
    url: siteConfig.url + '/a-propos/',
    image: siteConfig.author.avatar,
    sameAs: siteConfig.author.sameAs,
  };
}

export function buildWebSiteSchema(siteConfig) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: siteConfig.name,
    url: siteConfig.url,
    description: siteConfig.description,
    inLanguage: 'fr-FR',
    potentialAction: {
      '@type': 'SearchAction',
      target: `${siteConfig.url}/?q={search_term_string}`,
      'query-input': 'required name=search_term_string',
    },
  };
}

export function buildProductSchema(p) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    description: p.description,
    brand: { '@type': 'Brand', name: p.brand },
    ...(p.image ? { image: p.image } : {}),
    url: p.url,
    ...(p.offerUrl
      ? {
          offers: {
            '@type': 'Offer',
            url: p.offerUrl,
            availability: 'https://schema.org/InStock',
            priceCurrency: 'EUR',
          },
        }
      : {}),
  };
}
