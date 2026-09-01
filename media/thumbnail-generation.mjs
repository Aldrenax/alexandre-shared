import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ARTICLE_THUMBNAIL_POLICY, buildBannerPrompt, buildBannerRepairPrompt } from './editorial.mjs';
import { evaluateThumbnailCandidate, inspectThumbnailFile } from './thumbnail-qa.mjs';

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function fraction(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function validIsoDate(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function thumbnailItemLedgerStateName(key) {
  const digest = createHash('sha256').update(String(key)).digest('hex').slice(0, 32);
  return `thumbnail-item-attempts-${digest}`;
}

function normalizedAttemptLedger(attemptLedger) {
  if (!attemptLedger) return null;
  const store = attemptLedger.store;
  const key = String(attemptLedger.key || '').trim();
  if (!store?.updateLocked || !store?.read || !key) {
    throw new Error('Ledger persistant de tentatives miniature invalide');
  }
  return {
    store,
    key,
    stateName: thumbnailItemLedgerStateName(key),
    minimumAttempts: nonNegativeInteger(attemptLedger.minimumAttempts, 0),
    maximumAttempts: positiveInteger(attemptLedger.maximumAttempts, 9),
    scope: String(attemptLedger.scope || 'thumbnail-generation'),
  };
}

export function thumbnailItemAttemptSnapshot(attemptLedger) {
  const ledger = normalizedAttemptLedger(attemptLedger);
  if (!ledger) return null;
  const state = ledger.store.read(ledger.stateName, {});
  if (state?.key && state.key !== ledger.key) {
    throw new Error('Collision de ledger miniature détectée');
  }
  const attempts = Math.min(
    ledger.maximumAttempts,
    Math.max(ledger.minimumAttempts, nonNegativeInteger(state?.attempts, 0)),
  );
  return {
    key: ledger.key,
    attempts,
    maximumAttempts: ledger.maximumAttempts,
    remainingAttempts: Math.max(0, ledger.maximumAttempts - attempts),
    exhausted: attempts >= ledger.maximumAttempts,
  };
}

export function reserveThumbnailItemAttempt(attemptLedger, {
  globalAttempt = null,
  now = new Date(),
} = {}) {
  const ledger = normalizedAttemptLedger(attemptLedger);
  if (!ledger) return { allowed: true, attempt: null, token: null, attempts: null };
  const checkedAt = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(checkedAt.getTime())) throw new Error('Date de réservation miniature invalide');
  let reservation;
  const persisted = ledger.store.updateLocked(ledger.stateName, (current = {}) => {
    if (current?.key && current.key !== ledger.key) {
      throw new Error('Collision de ledger miniature détectée');
    }
    const attempts = Math.min(
      ledger.maximumAttempts,
      Math.max(ledger.minimumAttempts, nonNegativeInteger(current?.attempts, 0)),
    );
    if (attempts >= ledger.maximumAttempts) {
      reservation = {
        allowed: false,
        reason: 'thumbnail-item-attempt-limit-exhausted',
        attempts,
        maximumAttempts: ledger.maximumAttempts,
      };
      return {
        version: 1,
        key: ledger.key,
        attempts,
        maximumAttempts: ledger.maximumAttempts,
        reservations: Array.isArray(current?.reservations) ? current.reservations.slice(-ledger.maximumAttempts) : [],
        updatedAt: checkedAt.toISOString(),
      };
    }
    const token = randomUUID();
    const nextAttempt = attempts + 1;
    const entry = {
      token,
      attempt: nextAttempt,
      globalAttempt: Number.isInteger(globalAttempt) ? globalAttempt : null,
      scope: ledger.scope,
      reservedAt: checkedAt.toISOString(),
    };
    reservation = {
      allowed: true,
      token,
      attempt: nextAttempt,
      attempts: nextAttempt,
      maximumAttempts: ledger.maximumAttempts,
    };
    return {
      version: 1,
      key: ledger.key,
      attempts: nextAttempt,
      maximumAttempts: ledger.maximumAttempts,
      reservations: [...(Array.isArray(current?.reservations) ? current.reservations : []), entry]
        .slice(-ledger.maximumAttempts),
      updatedAt: checkedAt.toISOString(),
    };
  }, {
    version: 1,
    key: ledger.key,
    attempts: ledger.minimumAttempts,
    maximumAttempts: ledger.maximumAttempts,
    reservations: [],
  }, {
    lockName: `${ledger.stateName}-state`,
    ttlMs: 30_000,
    timeoutMs: 30_000,
  });
  return {
    ...reservation,
    attempts: persisted.attempts,
  };
}

export class ThumbnailGenerationBudget {
  constructor({
    maximumAttempts = 1_500,
    consecutiveFailureLimit = 8,
    failureRateWindow = 20,
    failureRateLimit = 0.70,
    cooldownMs = 60 * 60_000,
    stateStore = null,
    stateName = 'thumbnail-generation-circuit',
    now = () => new Date(),
  } = {}) {
    this.maximumAttempts = positiveInteger(maximumAttempts, 1_500);
    this.consecutiveFailureLimit = positiveInteger(consecutiveFailureLimit, 8);
    this.failureRateWindow = positiveInteger(failureRateWindow, 20);
    this.failureRateLimit = fraction(failureRateLimit, 0.70);
    this.cooldownMs = positiveInteger(cooldownMs, 60 * 60_000);
    this.stateStore = stateStore;
    this.stateName = stateName;
    this.stateLockName = `${stateName}-state`;
    this.now = now;
    this.attempts = 0;
    this.consecutiveFailures = 0;
    this.outcomes = [];
    this.openReason = null;
    this.openedAt = null;
    this.nextRetryAt = null;
    this.refresh();
  }

  currentDate() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('Horloge du circuit miniature invalide');
    return date;
  }

  applyState(state = {}) {
    this.attempts = nonNegativeInteger(state.attempts, 0);
    this.consecutiveFailures = nonNegativeInteger(state.consecutiveFailures, 0);
    this.outcomes = Array.isArray(state.outcomes)
      ? state.outcomes.slice(-this.failureRateWindow).map(Boolean)
      : [];
    this.openReason = typeof state.openReason === 'string' && state.openReason ? state.openReason : null;
    this.openedAt = validIsoDate(state.openedAt);
    this.nextRetryAt = validIsoDate(state.nextRetryAt);
  }

  serializedState() {
    const now = this.currentDate().toISOString();
    return {
      version: 1,
      updatedAt: now,
      maximumAttempts: this.maximumAttempts,
      consecutiveFailureLimit: this.consecutiveFailureLimit,
      failureRateWindow: this.failureRateWindow,
      failureRateLimit: this.failureRateLimit,
      cooldownMs: this.cooldownMs,
      attempts: this.attempts,
      consecutiveFailures: this.consecutiveFailures,
      outcomes: this.outcomes,
      openReason: this.openReason,
      openedAt: this.openedAt,
      nextRetryAt: this.nextRetryAt,
    };
  }

  cooldownExpired() {
    return Boolean(this.openReason && this.nextRetryAt
      && Date.parse(this.nextRetryAt) <= this.currentDate().getTime());
  }

  clearCircuitState() {
    this.attempts = 0;
    this.consecutiveFailures = 0;
    this.outcomes = [];
    this.openReason = null;
    this.openedAt = null;
    this.nextRetryAt = null;
  }

  openInMemory(reason) {
    if (!this.openReason) {
      const openedAt = this.currentDate();
      this.openReason = reason;
      this.openedAt = openedAt.toISOString();
      this.nextRetryAt = new Date(openedAt.getTime() + this.cooldownMs).toISOString();
    }
  }

  mutateLocked(mutator) {
    if (typeof mutator !== 'function') throw new Error('Mutation du circuit miniature requise');
    if (this.stateStore?.updateLocked) {
      let result;
      const persisted = this.stateStore.updateLocked(this.stateName, (current) => {
        this.applyState(current);
        if (this.cooldownExpired()) this.clearCircuitState();
        result = mutator();
        return this.serializedState();
      }, { version: 1 }, {
        lockName: this.stateLockName,
        ttlMs: 30_000,
        timeoutMs: 30_000,
      });
      this.applyState(persisted);
      return result;
    }

    // Les budgets sans StateStore restent utiles dans les tests unitaires et
    // conservent exactement les mêmes transitions, mais sans persistance.
    if (this.cooldownExpired()) this.clearCircuitState();
    return mutator();
  }

  refresh() {
    if (this.stateStore?.read) {
      this.applyState(this.stateStore.read(this.stateName, { version: 1 }));
    }
    if (this.cooldownExpired()) {
      this.resetAfterCooldown();
    }
    return this;
  }

  open(reason) {
    return this.mutateLocked(() => {
      this.openInMemory(reason);
      return this.openReason;
    });
  }

  resetAfterCooldown() {
    return this.mutateLocked(() => {
      // mutateLocked relit l'état sous verrou et applique le reset uniquement
      // s'il est encore expiré. Un second processus ne peut donc pas effacer
      // une réservation créée juste après le premier reset.
      if (this.cooldownExpired()) this.clearCircuitState();
      return !this.openReason;
    });
  }

  canAttempt() {
    return this.mutateLocked(() => {
      if (this.openReason) {
        return { allowed: false, reason: this.openReason, nextRetryAt: this.nextRetryAt };
      }
      if (this.attempts >= this.maximumAttempts) {
        this.openInMemory('global-attempt-budget-exhausted');
        return { allowed: false, reason: this.openReason, nextRetryAt: this.nextRetryAt };
      }
      return { allowed: true, reason: null, nextRetryAt: null };
    });
  }

  startAttempt() {
    return this.mutateLocked(() => {
      if (this.openReason) {
        return { allowed: false, reason: this.openReason, nextRetryAt: this.nextRetryAt };
      }
      if (this.attempts >= this.maximumAttempts) {
        this.openInMemory('global-attempt-budget-exhausted');
        return { allowed: false, reason: this.openReason, nextRetryAt: this.nextRetryAt };
      }
      this.attempts += 1;
      return { allowed: true, attempt: this.attempts };
    });
  }

  record(passed) {
    return this.mutateLocked(() => {
      this.outcomes.push(Boolean(passed));
      if (this.outcomes.length > this.failureRateWindow) this.outcomes.shift();
      this.consecutiveFailures = passed ? 0 : this.consecutiveFailures + 1;
      if (this.consecutiveFailures >= this.consecutiveFailureLimit) {
        this.openInMemory(`consecutive-failures-${this.consecutiveFailures}`);
        return;
      }
      if (this.outcomes.length >= this.failureRateWindow) {
        const failures = this.outcomes.filter((outcome) => !outcome).length;
        if (failures / this.outcomes.length >= this.failureRateLimit) {
          this.openInMemory(`failure-rate-${failures}/${this.outcomes.length}`);
        }
      }
    });
  }

  snapshot() {
    this.refresh();
    return {
      maximumAttempts: this.maximumAttempts,
      attempts: this.attempts,
      remainingAttempts: Math.max(0, this.maximumAttempts - this.attempts),
      consecutiveFailures: this.consecutiveFailures,
      circuitOpen: Boolean(this.openReason),
      circuitReason: this.openReason,
      openedAt: this.openedAt,
      nextRetryAt: this.nextRetryAt,
    };
  }

  static fromEnvironment(env = process.env, { stateStore = null, now = () => new Date() } = {}) {
    return new ThumbnailGenerationBudget({
      maximumAttempts: positiveInteger(env.MEDIA_ENGINE_THUMBNAIL_GLOBAL_ATTEMPT_BUDGET, 1_500),
      consecutiveFailureLimit: positiveInteger(env.MEDIA_ENGINE_THUMBNAIL_CIRCUIT_CONSECUTIVE_FAILURES, 8),
      failureRateWindow: positiveInteger(env.MEDIA_ENGINE_THUMBNAIL_CIRCUIT_WINDOW, 20),
      failureRateLimit: fraction(env.MEDIA_ENGINE_THUMBNAIL_CIRCUIT_FAILURE_RATE, 0.70),
      cooldownMs: positiveInteger(env.MEDIA_ENGINE_THUMBNAIL_CIRCUIT_COOLDOWN_MINUTES, 60) * 60_000,
      stateStore,
      now,
    });
  }
}

function failureQa(code, message) {
  const entry = { code, message, severity: 'error' };
  return {
    version: 1,
    policy: ARTICLE_THUMBNAIL_POLICY,
    passed: false,
    issueCodes: [code],
    issues: [entry],
  };
}

export async function generateThumbnailWithQa({
  hermes,
  media,
  draft,
  materialize,
  candidatePathForAttempt,
  budget,
  attemptLedger = null,
  maxAttempts = 3,
  inspect = inspectThumbnailFile,
  now = () => new Date(),
}) {
  if (!hermes?.generateBannerJson) throw new Error('Client Hermes image requis');
  if (typeof materialize !== 'function') throw new Error('Normaliseur de miniature requis');
  if (typeof candidatePathForAttempt !== 'function') throw new Error('Chemin de candidat requis');
  const attemptLimit = positiveInteger(maxAttempts, 3);
  const attempts = [];
  let itemAttempts = thumbnailItemAttemptSnapshot(attemptLedger)?.attempts ?? null;
  let previousIssues = [];
  let lastQa = null;
  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    const availability = budget.canAttempt();
    if (!availability.allowed) {
      return {
        passed: false,
        deferred: true,
        retryable: true,
        attempts,
        itemAttempts,
        qa: failureQa('thumbnail-circuit-open', availability.reason),
        circuitReason: availability.reason,
        nextRetryAt: availability.nextRetryAt || budget.snapshot().nextRetryAt,
      };
    }
    const itemPermit = reserveThumbnailItemAttempt(attemptLedger);
    itemAttempts = itemPermit.attempts ?? itemAttempts;
    if (!itemPermit.allowed) {
      return {
        passed: false,
        deferred: false,
        retryable: false,
        attemptLimitReached: true,
        attempts,
        itemAttempts,
        qa: failureQa('thumbnail-item-attempt-limit-exhausted', `Plafond de ${itemPermit.maximumAttempts} tentatives atteint`),
        circuitReason: null,
        nextRetryAt: null,
      };
    }
    const permit = budget.startAttempt();
    if (!permit.allowed) {
      return {
        passed: false,
        deferred: true,
        retryable: true,
        attempts,
        itemAttempts,
        qa: failureQa('thumbnail-circuit-open', permit.reason),
        circuitReason: permit.reason,
        nextRetryAt: permit.nextRetryAt || budget.snapshot().nextRetryAt,
      };
    }
    const path = candidatePathForAttempt(attempt);
    let modelResult = null;
    let visualInspection = null;
    let qa;
    try {
      const prompt = attempt === 1
        ? buildBannerPrompt({ media, draft })
        : buildBannerRepairPrompt({ media, draft, issues: previousIssues, attempt });
      modelResult = await hermes.generateBannerJson(prompt);
      const imageSource = modelResult?.imageSource || modelResult?.imageUrl || modelResult?.image;
      if (!modelResult?.success || !imageSource) throw new Error('Génération d’image Hermes invalide');
      await materialize(imageSource, path);
      const inspection = await inspect(path, media);
      if (!hermes?.inspectThumbnailJson) throw new Error('Inspection visuelle indépendante Hermes requise');
      visualInspection = await hermes.inspectThumbnailJson({ path, media, draft, inspection });
      qa = evaluateThumbnailCandidate({ draft, media, modelResult, inspection, visualInspection });
    } catch (error) {
      qa = failureQa('thumbnail-generation-error', String(error?.message || error));
    }
    lastQa = qa;
    const receipt = {
      attempt,
      itemAttempt: itemPermit.attempt,
      globalAttempt: permit.attempt,
      checkedAt: now().toISOString(),
      path,
      passed: qa.passed,
      issueCodes: qa.issueCodes,
      issues: qa.issues,
    };
    attempts.push(receipt);
    budget.record(qa.passed);
    if (qa.passed) {
      return {
        passed: true,
        deferred: false,
        retryable: false,
        path,
        modelResult,
        qa,
        attempts,
        itemAttempts,
        circuitReason: null,
        nextRetryAt: null,
      };
    }
    previousIssues = qa.issues;
    if (!budget.canAttempt().allowed) break;
  }
  const budgetState = budget.snapshot();
  return {
    passed: false,
    deferred: budgetState.circuitOpen,
    retryable: budgetState.circuitOpen,
    attempts,
    itemAttempts,
    qa: lastQa || failureQa('thumbnail-generation-not-attempted', 'Aucune tentative possible'),
    circuitReason: budgetState.circuitReason,
    nextRetryAt: budgetState.nextRetryAt,
  };
}

export function promoteThumbnailCandidate(candidatePath, finalPath, {
  backupRoot = null,
  mediaSlug = 'unknown',
  stamp = new Date().toISOString().replace(/[:.]/gu, '-'),
} = {}) {
  if (!existsSync(candidatePath)) throw new Error(`Candidat miniature introuvable: ${candidatePath}`);
  let backupPath = null;
  if (existsSync(finalPath) && backupRoot) {
    backupPath = join(backupRoot, stamp, mediaSlug, basename(finalPath));
    mkdirSync(dirname(backupPath), { recursive: true, mode: 0o750 });
    copyFileSync(finalPath, backupPath);
  }
  mkdirSync(dirname(finalPath), { recursive: true, mode: 0o750 });
  renameSync(candidatePath, finalPath);
  return { finalPath, backupPath };
}
