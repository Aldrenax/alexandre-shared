import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { PublicationWorker } from './publication-worker.mjs';
import { readJson, writeJsonAtomic } from './state-store.mjs';
import { WordPressDraftPublisher, wordpressTarget } from './wordpress-draft-publisher.mjs';

function wordpressPublicUrl(draft) {
  const target = wordpressTarget(draft);
  const route = draft.contentType === 'news'
    ? target.newsRoute
    : draft.contentType === 'video'
      ? 'videos'
      : draft.contentType === 'guide'
        ? 'guides'
        : null;
  if (!route) throw new Error(`Type WordPress non pris en charge: ${draft.contentType}`);
  return `https://${target.domain}/${route}/${draft.slug}/`;
}

/**
 * Publieur de production WordPress. Il réutilise les sélecteurs, limites et
 * vérifications de PublicationWorker mais ne dépend plus d'un dépôt Astro.
 */
export class WordPressPublicationWorker extends PublicationWorker {
  constructor({ store, env = process.env, now = () => new Date(), fetchImpl = fetch } = {}) {
    super({ store, env, now, fetchImpl });
    this.wordpress = new WordPressDraftPublisher({ store, env, now });
  }

  decisionFor(draft) {
    const decision = super.decisionFor(draft);
    // La migration WordPress a remplacé le shadow Git. Les validations de
    // qualité, l'éligibilité, les dates et la planification restent actives.
    decision.blockers = decision.blockers.filter((blocker) => !(
      blocker === 'git-push-disabled'
      || blocker.startsWith('git-publisher-excluded:')
      || blocker.startsWith('shadow-period-')
    ));
    decision.allowed = decision.blockers.length === 0;
    decision.action = decision.allowed ? 'publish' : 'keep-draft';
    return decision;
  }

  async reconcileUnverified() {
    // Les reçus Git/Astro antérieurs sont conservés comme historique, mais
    // leurs URL ne sont plus des cibles WordPress et ne doivent pas générer
    // d'échecs 404 à chaque cycle.
    return { inspected: 0, results: [], skipped: 'legacy-astro-reconciliation-retired' };
  }

  async publishDraftPath(draftPath, { dryRun = false, verifyLive = true } = {}) {
    const absoluteDraftPath = resolve(draftPath);
    if (!existsSync(absoluteDraftPath)) throw new Error(`Brouillon introuvable: ${absoluteDraftPath}`);
    const draft = readJson(absoluteDraftPath, null);
    if (!draft) throw new Error(`Brouillon JSON invalide: ${absoluteDraftPath}`);
    const decision = this.decisionFor(draft);
    const publicUrl = wordpressPublicUrl(draft);
    if (dryRun || !decision.allowed) return { dryRun, allowed: decision.allowed, decision, publicUrl, draftPath: absoluteDraftPath };

    const wordpress = await this.wordpress.publishAutomaticDraftPath(absoluteDraftPath, { dryRun: false });
    const live = verifyLive
      ? await this.verifyLive(publicUrl, draft.title)
      : { verified: null, reason: 'verification-disabled' };
    const receipt = {
      ...wordpress,
      status: live.verified === false ? 'published-unverified' : 'published',
      publishedAt: wordpress.publishedAt,
      publicUrl,
      live,
    };
    const receiptPath = join(this.store.stateDir, 'publication-receipts', draft.mediaSlug, `${draft.slug}.json`);
    writeJsonAtomic(receiptPath, receipt);
    this.store.markEvent(`published:${draft.mediaSlug}:${draft.contentType}:${draft.slug}`, receipt);
    this.store.enqueue('events', `published-${draft.mediaSlug}-${draft.contentType}-${draft.slug}`, {
      type: live.verified ? 'editorial.article.published' : 'editorial.article.published-unverified',
      createdAt: this.now().toISOString(),
      ...receipt,
      bannerPath: draft.banner?.path || null,
      title: draft.title || null,
    });
    return { ...receipt, receiptPath };
  }
}
