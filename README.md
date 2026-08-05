# alexandre-shared

Code partagé entre les sites du réseau Alexandre Chaimbault.

## Sites consommateurs

- [`alexandre-investissement`](https://github.com/Aldrenax/alexandre-investissement) — Finance & Investissement
- [`alexandre-tesla-tech`](https://github.com/Aldrenax/alexandre-tesla-tech) — Tesla & véhicules électriques
- *À venir : Entreprise, Affiliation, Logiciels*

## Contenu

| Fichier | Description |
|---|---|
| `STYLE_GUIDE_BASE.md` | Règles éditoriales communes (voix Je, anti-em-dash, structure, FAQ, affiliation, backlinks réseau, anti-patterns). Chaque site complète via `channel.config.mjs.editorialBrief`. |
| `lib/seo.mjs` | Builders Schema.org (`buildArticleSchema`, `buildVideoSchema`, `buildBreadcrumbSchema`, `buildFaqSchema`, `buildPersonSchema`, `buildWebSiteSchema`, `buildProductSchema`). Tous factorisés : acceptent `siteConfig` en paramètre. |
| `lib/utm.mjs` | UTM URL builder (`addUtm`, `campaignFromSlug`). Pas de dépendance externe. |
| `config/media-network.mjs` | Registre canonique des huit chaînes, six médias actifs et sources officielles/secondaires. |
| `media/` | Hermes Media Engine : collecte, `x_search`, qualification, rédaction ChatGPT, bannières, QA, état et routage. |
| `bin/media-engine.mjs` | CLI prévue pour le VPS. Le mode de publication reste `draft` tant que l'activation n'est pas explicitement approuvée. |

## Hermes Media Engine

Le moteur est conçu pour tourner sur le VPS `chaimbault` et utiliser Hermes comme
interface d'inférence, de recherche X, de génération d'images et de notification.
Le Mac n'est pas un prérequis d'exploitation.

```bash
npm run media:validate
node bin/media-engine.mjs run --dry-run
node bin/media-engine.mjs research --media tesla-tech --dry-run
node bin/media-engine.mjs video --media logiciels --dry-run
node bin/media-engine.mjs guide --media entreprise --dry-run
```

Le détail du contrat, des gates et des unités systemd se trouve dans
[`docs/HERMES_MEDIA_ENGINE.md`](docs/HERMES_MEDIA_ENGINE.md).

## Installation côté site consommateur

```json
// package.json du site
{
  "dependencies": {
    "alexandre-shared": "github:Aldrenax/alexandre-shared#main"
  }
}
```

Puis `npm install`. Pour une version pinned, remplacer `#main` par un tag/sha :
`"alexandre-shared": "github:Aldrenax/alexandre-shared#v0.1.0"`.

## Usage

### STYLE_GUIDE éditorial

```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STYLE_GUIDE_BASE_PATH = fileURLToPath(
  new URL('../../node_modules/alexandre-shared/STYLE_GUIDE_BASE.md', import.meta.url),
);
const STYLE_GUIDE_BASE = readFileSync(STYLE_GUIDE_BASE_PATH, 'utf8');

// Concaténer avec le brief spécifique du site
const fullStyleGuide = STYLE_GUIDE_BASE + '\n\n' + CHANNEL.editorialBrief;
```

### Schema.org builders

```ts
// src/pages/actualites/[...slug].astro
---
import { buildArticleSchema, buildFaqSchema } from 'alexandre-shared/lib/seo.mjs';
import { SITE } from '../../lib/site';

const articleSchema = buildArticleSchema({
  title: entry.data.title,
  description: entry.data.description,
  url: `${SITE.url}/actualites/${entry.slug}/`,
  datePublished: entry.data.pubDate,
  image: entry.data.coverUrl,
  wordCount: entry.data.wordCount,
}, SITE);

const faqSchema = entry.data.faq?.length > 0
  ? buildFaqSchema(entry.data.faq)
  : null;
---
```

### UTM

```js
// scripts/youtube-to-article.mjs
import { addUtm } from 'alexandre-shared/lib/utm.mjs';
import { CHANNEL } from '../channel.config.mjs';

const tracked = addUtm('https://partner.com/ref', {
  source: CHANNEL.utmSource,
  campaign: 'article-slug',
});
```

## Versioning

| Version | Date | Changements |
|---|---|---|
| 0.1.0 | 2026-05-14 | Initial : STYLE_GUIDE_BASE, lib/seo.mjs, lib/utm.mjs |
| 0.2.0 | 2026-08-03 | Pipeline YouTube et Whisper mutualisé. |
| 0.3.0 | 2026-08-05 | Hermes Media Engine en mode brouillon, sans déploiement. |

Les bumps de version se font par tag git (`git tag v0.2.0 && git push --tags`). Les sites pinnés sur `#main` reçoivent le dernier au prochain `npm install`.

## Roadmap

- **v0.4.0** : extraire les composants Astro génériques (`Schema.astro`, `YouTubeEmbed.astro`, `AffiliateCard.astro`, `RelatedArticles.astro`, `TableOfContents.astro`, `ReadingProgress.astro`).
- **v0.5.0** : apprendre les créneaux depuis GSC et les performances réelles, sans inventer un effet SEO de l'heure de publication.
- **v1.0.0** : tout le code dupliqué entre Invest et Tesla est ici. Plus de drift possible.
