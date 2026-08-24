# Hermes Media Engine

Statut au 24 août 2026 : le moteur publie directement dans le réseau WordPress
des six sites. Git et Astro ne participent plus à la publication éditoriale.
Les limites de cadence et les contrôles qualité décrits ci-dessous restent
obligatoires.

## Périmètre

Le moteur couvre :

- Alexandre Chaimbault ;
- Tesla & Tech ;
- Affiliation & Référencement ;
- Logiciels & Marketing ;
- Finance & Investissement ;
- Entreprise & Comptabilité.

Daily et AskOptimize restent dans le registre et dans Telegram, mais
`editorialEnabled=false` interdit leur production éditoriale.

## Responsabilités

| Composant | Responsabilité |
|---|---|
| `chaimbault` | Collecte, recherche, rédaction, images, QA, état, staging des sites et publication après gate. |
| Hermes | ChatGPT via `openai-codex/gpt-5.6-terra`, outil `x_search`, outil `image_gen`, `hermes send`, supervision et décisions Telegram. |
| `askoptimize` | Deuxième authentification Grok et secours. Aucun job réseau actif tant que le lease principal est sain. |
| GitHub | Version du code et origine des déploiements Cloudflare, pas ordonnanceur. |
| Mac | Développement et administration ponctuels uniquement. |

## Invariants

1. Une absence de donnée reste `null` ou `indisponible`, jamais zéro.
2. Une erreur de source n'est pas une absence d'actualité.
3. X est un radar. Un résultat sans citation est `degraded` et n'entre pas dans un article. Une panne X ne bloque jamais RSS ni les sources officielles.
4. Une rumeur ne déclenche jamais une publication automatique.
5. Finance, droit, fiscalité et sécurité produit exigent une source officielle.
6. Une offre ne peut être intégrée que si le registre Studio la marque active, fournit une URL et rattache l'offre au média.
7. Chaque article doit avoir une bannière locale, une source citée et un registre d'affirmations. Les Actualités et Guides utilisent une adaptation à image unique de `youtube-thumbnail-imagegen`; les articles Vidéos conservent la miniature YouTube associée.
8. La qualité prévaut sur le quota quotidien.
9. `publicationMode=draft` est la valeur initiale et sûre.
10. Un déploiement, une activation de publication ou un push exige une autorisation séparée.
11. Tous les messages opérationnels passent par `hermes send`. L'API Telegram directe reste réservée au provisionnement des topics.

## Relais WordPress du réseau

Le worker WordPress cible directement les six médias. Il crée le contenu,
contrôle sa disponibilité publique puis conserve un reçu par publication. La
configuration du réseau exige trois preuves cumulatives :

1. le compte technique Hermes est membre du blog WordPress attendu avec le seul
   rôle `alexandre_hermes_draft` ;
2. l'endpoint de ce blog répond avec son `site_key` exact et
   `publication_mode=draft-only` ;
3. le slug du média est ajouté explicitement à `WORDPRESS_DRAFT_MEDIA_SLUGS`.

La matrice est fixe : `tesla-tech -> tesla`, puis Affiliation, Logiciels,
Entreprise et Investissement gardent leur slug. Les Actualités thématiques sont
créées en type `actualite` et sous `/actualites/`; le principal conserve
`article` sous `/blog/`. Les Vidéos et Guides restent sous `/videos/` et
`/guides/` sur tous les sites.

Avant le mapping d'un domaine, le worker peut utiliser le chemin technique du
Multisite sous `alexandrechaimbault.com`. Après le mapping et la bascule DNS,
`WORDPRESS_DRAFT_SITE_URLS_JSON` doit fixer l'URL finale du média. Exemple de
syntaxe dans le fichier systemd protégé :

```text
WORDPRESS_DRAFT_MEDIA_SLUGS=chaimbault,affiliation
WORDPRESS_DRAFT_SITE_URLS_JSON='{"affiliation":"https://alexandre-affiliation.fr/"}'
```

Le relais est idempotent, refuse une identité de blog inattendue et n'autorise
jamais de suppression. Un contenu qualifié est ajouté à la file
`publication-ready`, publiée par événement de fichier et reprise toutes les dix
minutes. Les erreurs sont rejouées avec un délai croissant, puis isolées après
cinq tentatives. Une publication WordPress non encore visible entre dans une
file de vérification séparée, sans jamais être publiée une deuxième fois.

## Pipeline d'actualité

1. Collecte conditionnelle des RSS, API et pages officielles.
2. Lecture de X via Hermes `x_search`.
3. Normalisation et suppression des paramètres de tracking.
4. Regroupement des sources couvrant le même événement.
5. Qualification thématique, fraîcheur, preuve et offre.
6. Rédaction JSON par ChatGPT via Hermes.
7. Génération d'une seule bannière avec `image_gen`, selon la politique `youtube-thumbnail-imagegen:article-single-v1`, sans modifier la skill source.
8. Conversion locale en WebP 1200x630.
9. QA déterministe, avec au plus une réparation textuelle bornée par défaut pour
   les écarts sûrs (longueur, structure, mentions obligatoires). Une erreur de
   preuve, de rumeur, de source ou de bannière reste bloquante.
10. Écriture d'un brouillon dans `/var/lib/alexandre-media-engine/drafts`.
11. Ajout immédiat à `queue/publication-ready` lorsqu'il est éligible.
12. Publication directe et vérification publique. Les contrôles de quota et de
    fraîcheur restent appliqués.

La rédaction produit au plus un brouillon d'actualité par média et par cycle.
L'idempotence interdit une seconde génération pour le même candidat.

## Pipeline vidéo

1. Flux officiel YouTube de chaque chaîne.
2. Rejet des Shorts et lives.
3. Métadonnées et transcription YouTube, puis Whisper local en repli.
4. Extraction de l'URL principale de la description.
5. Rattachement uniquement à une offre active du Studio ayant le même domaine.
6. Téléchargement de la miniature YouTube originale.
7. Article de 2 000 à 4 500 mots, section `videos`.
8. QA puis brouillon. Une URL non rattachée à une offre active reste observée,
   mais n'est pas promue.

## Pipeline guide

Le guide hebdomadaire ne part pas d'une simple suggestion de modèle. Il exige
une entrée dans `MEDIA_ENGINE_GUIDE_OPPORTUNITIES_PATH` contenant :

- un média ;
- une intention et un titre ;
- une preuve de demande GSC, Google, YouTube ou une URL d'étude ;
- une offre active ;
- au moins une source ;
- une source officielle pour les thèmes sensibles.

Sans ces éléments, le cycle retourne un blocage explicite. Le guide cible
3 500 à 7 500 mots et reste un brouillon jusqu'au gate de publication.

## État runtime

```text
/var/lib/alexandre-media-engine/
├── assets/<media>/
├── drafts/<media>/
├── locks/
├── queue/
│   ├── candidates/
│   ├── qualified/
│   ├── drafts/
│   ├── events/
│   └── newsletter-attribution/
└── state/
    ├── events.json
    ├── newsletter-attribution.json
    ├── source-health.json
    └── x-search-latest.json
```

Les écritures JSON sont atomiques. Le lease `network-cycle` évite un cycle
concurrent sur les deux VPS.

## Attribution newsletter shadow

Le service `alexandre-newsletter-shadow.service` prépare la simplification vers
une audience Systeme.io unique sans modifier les formulaires publics :

- écoute locale uniquement sur `127.0.0.1:8097` ;
- refuse tout média inactif et toute page dont le domaine ne correspond pas au média ;
- exige un consentement explicite, une version de formulaire et une clé d'idempotence ;
- conserve le média, la page, le référent sans query string, les UTM et l'heure ;
- remplace l'adresse email par un HMAC SHA-256 avant toute écriture ;
- n'appelle jamais Systeme.io et marque chaque événement `shadow-only`.

Activation sur une release déjà installée :

```bash
sudo deploy/activate-newsletter-shadow.sh --apply
curl --fail http://127.0.0.1:8097/health
```

Le script génère le secret HMAC dans
`/etc/alexandre-media-engine/newsletter-shadow.env`, sans l'afficher. L'étape
suivante, après validation séparée, sera de brancher un formulaire de test puis
la synchronisation vers l'unique tag et l'unique séquence Systeme.io.

## Authentification Grok

État observé avant déploiement : `x_search` est activé dans Hermes sur les deux
VPS, mais aucun credential `xai-oauth` n'est enregistré.

Procédure prévue, à exécuter seulement après accord :

```bash
ssh chaimbault
docker exec -it --user 10000:10000 hermes-agent /opt/hermes/.venv/bin/hermes auth add xai-oauth

ssh askoptimize
docker exec -it --user 10000:10000 hermes-agent /opt/hermes/.venv/bin/hermes auth add xai-oauth
```

La validation doit comporter une vraie recherche avec au moins une citation.
Un simple affichage dans `hermes auth list` ne suffit pas.

Une indisponibilité Grok place l'enrichissement X en état `degraded`, alerte
Hermes et déclenche une nouvelle tentative au cycle suivant. Elle ne bloque ni
les RSS, ni les sources officielles, ni un article déjà suffisamment prouvé.

## État de référence avant déploiement

Contrôle local en lecture seule du 5 août 2026 :

- 35 sources interrogées ;
- 30 sources obligatoires saines sur 30 ;
- 545 éléments collectés ;
- 18 recherches `x_search` planifiées ;
- cinq sources optionnelles dégradées : trois pages Tesla bloquées en HTTP 403,
  Légifrance en HTTP 403 et Urssaf instable ;
- aucune publication ni aucun push effectué.

L'ancien système `*-news.timer` reste actif sur le VPS et échoue sur une clé
Anthropic invalide. Il ne sera désactivé qu'au cutover, après la période shadow.

## Variables runtime

Voir `deploy/media-engine.env.example`. Les fichiers d'offres, opportunités et
liens internes sont des agrégats sans secrets produits par le Studio.

### Cadence de publication

Les limites ci-dessous sont des plafonds de publication réelle. Elles ne
forcent jamais un contenu à passer si les sources, la bannière, la QA ou un
autre garde-fou ne sont pas valides :

| Portée | Limite |
|---|---:|
| Réseau, tous contenus | 10 par jour |
| Réseau, Actualités | 8 par jour |
| Réseau, Actualités supplémentaires après la première de chaque média | 2 par jour |
| Réseau, Vidéos + Guides | 2 par jour |
| Un média, tous contenus | 2 par jour |
| Un média, Actualités | 2 par jour |
| Un média, Vidéos + Guides | 1 par jour |
| Un média, Vidéos | 1 par jour |
| Un média, Guides | 1 par fenêtre glissante de 7 jours |
| Réseau, intervalle minimal | 60 minutes |
| Un média, intervalle minimal | 4 heures |

L'ordre de sélection est dynamique : première Actualité du jour de chaque
média, puis Vidéo, puis seconde Actualité, puis Guide. À priorité égale, le
brouillon planifié ou généré le plus ancien passe en premier. Cette priorité
organise la file ; elle ne contourne ni les plafonds réseau/média ni les gates
de qualité. Daily et AskOptimize restent exclus de la production éditoriale.

Le publisher charge les fichiers dans cet ordre :
`/etc/alexandre-media-engine/media-engine.env`, puis `shadow.env`, puis
`publication.env`. Le dernier fichier surcharge donc les deux premiers pour les
gates et la cadence de publication. Une mise à jour du seul fichier exemple
Git ne modifie pas un VPS déjà installé.

Le code est installé par `deploy/install-media-engine.sh --apply` dans une
release immuable sous `/opt/alexandre-media-engine/releases/<id>`, puis le lien
`/opt/alexandre-media-engine/current` est basculé atomiquement vers celle-ci.
Il ne faut jamais modifier directement le contenu pointé par `current`.
L'installation conserve toutes les releases précédentes par défaut. Le nettoyage
des releases au-delà des six plus récentes exige l'option destructive séparée
`--prune-stale` et une autorisation explicite propre à cette suppression ; cette
option n'est jamais utilisée pendant une bascule de site.

`deploy/activate-publication.sh` migre `publication.env` sans recopier ni
afficher de secret : il conserve la date de cutover existante, crée un fichier
temporaire en mode `0640` et écrit uniquement les gates et paramètres non
secrets. La curation doit réussir avant que ce fichier soit rendu effectif.
L'ancien override est ensuite sauvegardé et le remplacement est atomique. Si la
désactivation des anciens timers ou l'activation du publisher échoue, le script
restaure l'ancien `publication.env` et remet exactement les états `enabled` et
`active` initialement observés pour le publisher et les cinq anciens timers. Le
succès exige ensuite une postcondition explicite : publisher actif et activé au
démarrage, anciens timers inactifs et désactivés. Les services lisent ce fichier
à chaque exécution ; aucune copie de `media-engine.env` ou d'un credential ne
doit entrer dans Git.

L'ajout progressif d'un site au relais de brouillons utilise
`bin/activate-wordpress-draft-site.mjs`. Sans `--apply`, la commande vérifie
l'ordre du canari, l'URL finale, le blog ID, l'identité `site_key`, le mode
`draft-only` et l'absence de droits de publication/suppression, puis quitte sans
modifier le fichier. Avec l'autorisation explicite et `--apply`, elle sauvegarde
`wordpress-shadow.env`, remplace atomiquement uniquement les listes de slugs et
d'URL, puis répète la preuve de santé. Elle n'active ni ne démarre aucun timer.

## Commandes de validation

```bash
npm test
npm audit --audit-level=high
node bin/media-engine.mjs validate --json
node bin/media-engine.mjs wordpress-health --media affiliation --json
node bin/media-engine.mjs run --dry-run --json
node bin/media-engine.mjs video --media logiciels --dry-run --json
node bin/media-engine.mjs guide --media entreprise --dry-run --json
```

## Intégration Studio et Telegram

Le Studio dispose déjà du registre chaîne vers topic, des bilans quotidiens,
des notifications vidéo/article et de l'idempotence. Le Media Engine ne doit
pas dupliquer ces modules.

Il ajoute des événements structurés :

```json
{
  "type": "editorial.draft.qa-passed",
  "mediaSlug": "logiciels",
  "candidateId": "...",
  "contentType": "news",
  "draftPath": "/var/lib/alexandre-media-engine/drafts/logiciels/...json"
}
```

Le Studio peut ensuite envoyer une carte dans le topic de la chaîne et une
décision dans `✅ Décisions à valider`. Les notifications publiques existantes
continuent à observer le sitemap après publication.

## Déploiement direct réseau

La publication directe est active partout, sans phase progressive. À chaque
mise à jour du moteur :

1. tester, pousser et installer la release sur `chaimbault` ;
2. recharger systemd et activer le timer ainsi que le watcher
   `alexandre-media-publish.path` ;
3. lancer un cycle réseau ;
4. vérifier `publication-status` et les URL publiques créées ;
5. ne revenir en arrière qu'en cas d'échec technique prouvé, sans effacer les
   brouillons, reçus ni preuves.

## Retour arrière

- désactiver les timers Media Engine ;
- conserver `/var/lib/alexandre-media-engine/state/events.json` ;
- ne supprimer aucun topic Telegram ;
- ne pas effacer les brouillons ou les preuves ;
- revenir à la release précédente du code ;
- ne jamais republier les événements déjà accusés.
