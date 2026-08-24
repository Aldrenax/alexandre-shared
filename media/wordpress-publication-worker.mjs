import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { PublicationWorker, publicationPriority } from './publication-worker.mjs';
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

function queueIdFor(draft) {
  return `${draft.mediaSlug}-${draft.contentType}-${draft.slug}`;
}

function retryDelayMinutes(attempts) {
  return Math.min(360, 5 * (2 ** Math.max(0, attempts - 1)));
}

function due(value, now) {
  const timestamp = Date.parse(value || '');
  return !Number.isFinite(timestamp) || timestamp <= now.getTime();
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

  syncReadyQueue({ mediaSlug = null, since = null } = {}) {
    const sinceAt = Date.parse(since || this.env.MEDIA_ENGINE_PUBLICATION_QUEUE_CUTOVER_AT || '');
    const queued = [];
    for (const { path, draft } of this.store.listDrafts(mediaSlug)) {
      if (!draft?.qa?.passed || draft?.publicationEligibility?.status !== 'eligible') continue;
      if (this.store.hasEvent(`published:${draft.mediaSlug}:${draft.contentType}:${draft.slug}`)) continue;
      const generatedAt = Date.parse(draft.generatedAt || '');
      if (Number.isFinite(sinceAt) && (!Number.isFinite(generatedAt) || generatedAt < sinceAt)) continue;
      const entryPath = this.store.enqueuePublicationReady(path, draft);
      if (entryPath) queued.push(entryPath);
    }
    return queued;
  }

  retryEntry(entry, error) {
    const attempts = Number(entry.payload?.attempts || 0) + 1;
    const queuedAt = entry.payload?.queuedAt || this.now().toISOString();
    const nextAttemptAt = new Date(this.now().getTime() + retryDelayMinutes(attempts) * 60_000).toISOString();
    const next = {
      ...entry.payload,
      attempts,
      queuedAt,
      nextAttemptAt,
      lastError: String(error?.message || error).slice(0, 500),
      lastAttemptAt: this.now().toISOString(),
    };
    if (attempts >= 5) {
      this.store.enqueue('publication-failed', entry.payload.queueId, { ...next, quarantinedAt: this.now().toISOString() });
      this.store.removeQueueEntry('publication-ready', entry.payload.queueId);
      return { status: 'quarantined', attempts, nextAttemptAt };
    }
    this.store.enqueue('publication-ready', entry.payload.queueId, next);
    return { status: 'retry-scheduled', attempts, nextAttemptAt };
  }

  retryVerification(entry, error) {
    const attempts = Number(entry.payload?.attempts || 0) + 1;
    const nextAttemptAt = new Date(this.now().getTime() + retryDelayMinutes(attempts) * 60_000).toISOString();
    const next = {
      ...entry.payload,
      attempts,
      nextAttemptAt,
      lastError: String(error?.message || error).slice(0, 500),
      lastAttemptAt: this.now().toISOString(),
    };
    if (attempts >= 5) {
      this.store.enqueue('publication-failed', `verification-${entry.payload.queueId}`, {
        ...next,
        status: 'verification-quarantined',
        quarantinedAt: this.now().toISOString(),
      });
      this.store.removeQueueEntry('publication-verification', entry.payload.queueId);
      return { status: 'verification-quarantined', attempts, nextAttemptAt };
    }
    this.store.enqueue('publication-verification', entry.payload.queueId, next);
    return { status: 'verification-retry-scheduled', attempts, nextAttemptAt };
  }

  async reconcileVerification({ dryRun = false, limit = 5 } = {}) {
    const now = this.now();
    const results = [];
    const held = [];
    for (const entry of this.store.listQueueEntries('publication-verification')) {
      if (results.length >= limit) break;
      if (!due(entry.payload?.nextAttemptAt, now)) {
        held.push({ queueId: entry.payload.queueId, nextAttemptAt: entry.payload.nextAttemptAt });
        continue;
      }
      const draft = readJson(entry.payload?.draftPath, null);
      if (!draft || !entry.payload?.publicUrl || !entry.payload?.receiptPath) {
        const retry = dryRun ? { status: 'dry-run-error' } : this.retryVerification(entry, new Error('Données de vérification incomplètes'));
        results.push({ queueId: entry.payload?.queueId, verified: false, retry });
        continue;
      }
      const live = await this.verifyLive(entry.payload.publicUrl, draft.title, { attempts: 1, intervalMs: 0 });
      if (!live.verified || dryRun) {
        const retry = dryRun ? { status: 'dry-run-unverified' } : this.retryVerification(entry, new Error(live.reason || 'Publication non visible'));
        results.push({ queueId: entry.payload.queueId, verified: false, live, retry });
        continue;
      }
      const receipt = readJson(entry.payload.receiptPath, {});
      const verifiedReceipt = { ...receipt, status: 'published', live, verifiedAt: this.now().toISOString() };
      if (!dryRun) {
        writeJsonAtomic(entry.payload.receiptPath, verifiedReceipt);
        this.store.markEvent(`published:${draft.mediaSlug}:${draft.contentType}:${draft.slug}`, verifiedReceipt);
        this.store.enqueue('events', `publication-verified-${draft.mediaSlug}-${draft.contentType}-${draft.slug}`, {
          type: 'editorial.article.published',
          createdAt: this.now().toISOString(),
          ...verifiedReceipt,
          bannerPath: draft.banner?.path || null,
          title: draft.title || null,
        });
        this.store.removeQueueEntry('publication-verification', entry.payload.queueId);
      }
      results.push({ queueId: entry.payload.queueId, verified: true, live, dryRun });
    }
    return { inspected: this.store.listQueueEntries('publication-verification').length, results, held };
  }

  publicationStatus() {
    const receipts = this.publicationReceipts();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(this.now());
    const todayReceipts = receipts.filter((receipt) => new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(receipt.publishedAt)) === today);
    const byMedia = Object.fromEntries([...new Set([
      ...this.store.listQueueEntries('publication-ready').map((entry) => entry.payload?.mediaSlug),
      ...todayReceipts.map((receipt) => receipt.mediaSlug),
    ].filter(Boolean))].sort().map((mediaSlug) => [mediaSlug, {
      ready: this.store.listQueueEntries('publication-ready').filter((entry) => entry.payload?.mediaSlug === mediaSlug).length,
      publishedToday: todayReceipts.filter((receipt) => receipt.mediaSlug === mediaSlug).length,
    }]));
    return {
      version: 1,
      observedAt: this.now().toISOString(),
      publicationMode: 'automatic-wordpress',
      ready: this.store.listQueueEntries('publication-ready').length,
      retrying: this.store.listQueueEntries('publication-ready').filter((entry) => entry.payload?.attempts > 0).length,
      quarantined: this.store.listQueueEntries('publication-failed').length,
      verificationPending: this.store.listQueueEntries('publication-verification').length,
      publishedToday: todayReceipts.length,
      byMedia,
    };
  }

  async run({ mediaSlug = null, dryRun = false, limit = 1 } = {}) {
    const lease = dryRun ? null : this.store.acquireLease('publication-cycle', { ttlMs: 50 * 60_000 });
    if (!dryRun && !lease) return { skipped: true, reason: 'publication-lease-active', results: [] };
    try {
      const verification = await this.reconcileVerification({ dryRun, limit: Math.max(1, limit) });
      const now = this.now();
      const receipts = this.publicationReceipts();
      const entries = this.store.listQueueEntries('publication-ready')
        .filter((entry) => !mediaSlug || entry.payload?.mediaSlug === mediaSlug)
        .map((entry) => ({ ...entry, draft: readJson(entry.payload?.draftPath, null) }))
        .filter((entry) => entry.draft?.qa?.passed && entry.draft?.publicationEligibility?.status === 'eligible');
      entries.sort((left, right) => {
        const leftPriority = publicationPriority(left.draft, receipts, now);
        const rightPriority = publicationPriority(right.draft, receipts, now);
        const leftAt = Date.parse(left.draft.scheduledPublishAt || left.draft.generatedAt || 0) || 0;
        const rightAt = Date.parse(right.draft.scheduledPublishAt || right.draft.generatedAt || 0) || 0;
        return leftPriority - rightPriority || leftAt - rightAt || left.payload.queueId.localeCompare(right.payload.queueId);
      });
      const held = [];
      const results = [];
      for (const entry of entries) {
        if (results.length >= limit) break;
        if (!due(entry.payload?.nextAttemptAt, now)) {
          held.push({ queueId: entry.payload.queueId, blockers: [`retry-until-${entry.payload.nextAttemptAt}`] });
          continue;
        }
        const decision = this.decisionFor(entry.draft);
        const blockers = [...decision.blockers, ...this.queueBlockersFor(entry.draft, receipts)];
        if (blockers.length) {
          held.push({ queueId: entry.payload.queueId, mediaSlug: entry.draft.mediaSlug, blockers });
          continue;
        }
        try {
          const published = await this.publishDraftPath(entry.payload.draftPath, { dryRun });
          results.push(published);
          if (!dryRun) {
            this.store.removeQueueEntry('publication-ready', entry.payload.queueId || queueIdFor(entry.draft));
            if (published?.publishedAt) receipts.push(published);
          }
        } catch (error) {
          const retry = dryRun ? { status: 'dry-run-error' } : this.retryEntry(entry, error);
          held.push({ queueId: entry.payload.queueId, error: String(error?.message || error), retry });
        }
      }
      const status = this.publicationStatus();
      if (!dryRun) this.store.write('editorial-dashboard', status);
      return {
        inspected: entries.length,
        heldCount: held.length,
        held: held.slice(0, 25),
        verification,
        results,
        status,
      };
    } finally {
      if (lease) this.store.releaseLease(lease);
    }
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
    if (live.verified === false) {
      this.store.enqueue('publication-verification', queueIdFor(draft), {
        version: 1,
        queueId: queueIdFor(draft),
        mediaSlug: draft.mediaSlug,
        contentType: draft.contentType,
        slug: draft.slug,
        title: draft.title,
        draftPath: absoluteDraftPath,
        receiptPath,
        publicUrl,
        queuedAt: this.now().toISOString(),
        attempts: 0,
        nextAttemptAt: new Date(this.now().getTime() + 5 * 60_000).toISOString(),
      });
    }
    return { ...receipt, receiptPath };
  }
}
