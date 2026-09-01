import { copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { buildBannerPrompt, buildBannerRepairPrompt } from './editorial.mjs';
import { evaluateThumbnailCandidate, inspectThumbnailFile } from './thumbnail-qa.mjs';

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function fraction(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}

export class ThumbnailGenerationBudget {
  constructor({
    maximumAttempts = 1_500,
    consecutiveFailureLimit = 8,
    failureRateWindow = 20,
    failureRateLimit = 0.70,
  } = {}) {
    this.maximumAttempts = positiveInteger(maximumAttempts, 1_500);
    this.consecutiveFailureLimit = positiveInteger(consecutiveFailureLimit, 8);
    this.failureRateWindow = positiveInteger(failureRateWindow, 20);
    this.failureRateLimit = fraction(failureRateLimit, 0.70);
    this.attempts = 0;
    this.consecutiveFailures = 0;
    this.outcomes = [];
    this.openReason = null;
  }

  canAttempt() {
    if (this.openReason) return { allowed: false, reason: this.openReason };
    if (this.attempts >= this.maximumAttempts) {
      this.openReason = 'global-attempt-budget-exhausted';
      return { allowed: false, reason: this.openReason };
    }
    return { allowed: true, reason: null };
  }

  startAttempt() {
    const decision = this.canAttempt();
    if (!decision.allowed) return decision;
    this.attempts += 1;
    return { allowed: true, attempt: this.attempts };
  }

  record(passed) {
    this.outcomes.push(Boolean(passed));
    if (this.outcomes.length > this.failureRateWindow) this.outcomes.shift();
    this.consecutiveFailures = passed ? 0 : this.consecutiveFailures + 1;
    if (this.consecutiveFailures >= this.consecutiveFailureLimit) {
      this.openReason = `consecutive-failures-${this.consecutiveFailures}`;
      return;
    }
    if (this.outcomes.length >= this.failureRateWindow) {
      const failures = this.outcomes.filter((outcome) => !outcome).length;
      if (failures / this.outcomes.length >= this.failureRateLimit) {
        this.openReason = `failure-rate-${failures}/${this.outcomes.length}`;
      }
    }
  }

  snapshot() {
    return {
      maximumAttempts: this.maximumAttempts,
      attempts: this.attempts,
      remainingAttempts: Math.max(0, this.maximumAttempts - this.attempts),
      consecutiveFailures: this.consecutiveFailures,
      circuitOpen: Boolean(this.openReason),
      circuitReason: this.openReason,
    };
  }

  static fromEnvironment(env = process.env) {
    return new ThumbnailGenerationBudget({
      maximumAttempts: positiveInteger(env.MEDIA_ENGINE_THUMBNAIL_GLOBAL_ATTEMPT_BUDGET, 1_500),
      consecutiveFailureLimit: positiveInteger(env.MEDIA_ENGINE_THUMBNAIL_CIRCUIT_CONSECUTIVE_FAILURES, 8),
      failureRateWindow: positiveInteger(env.MEDIA_ENGINE_THUMBNAIL_CIRCUIT_WINDOW, 20),
      failureRateLimit: fraction(env.MEDIA_ENGINE_THUMBNAIL_CIRCUIT_FAILURE_RATE, 0.70),
    });
  }
}

function failureQa(code, message) {
  const entry = { code, message, severity: 'error' };
  return { version: 1, passed: false, issueCodes: [code], issues: [entry] };
}

export async function generateThumbnailWithQa({
  hermes,
  media,
  draft,
  materialize,
  candidatePathForAttempt,
  budget,
  maxAttempts = 3,
  inspect = inspectThumbnailFile,
  now = () => new Date(),
}) {
  if (!hermes?.generateBannerJson) throw new Error('Client Hermes image requis');
  if (typeof materialize !== 'function') throw new Error('Normaliseur de miniature requis');
  if (typeof candidatePathForAttempt !== 'function') throw new Error('Chemin de candidat requis');
  const attemptLimit = positiveInteger(maxAttempts, 3);
  const attempts = [];
  let previousIssues = [];
  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    const permit = budget.startAttempt();
    if (!permit.allowed) {
      return { passed: false, attempts, qa: failureQa('thumbnail-circuit-open', permit.reason), circuitReason: permit.reason };
    }
    const path = candidatePathForAttempt(attempt);
    let modelResult = null;
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
      qa = evaluateThumbnailCandidate({ draft, media, modelResult, inspection });
    } catch (error) {
      qa = failureQa('thumbnail-generation-error', String(error?.message || error));
    }
    const receipt = {
      attempt,
      globalAttempt: permit.attempt,
      checkedAt: now().toISOString(),
      path,
      passed: qa.passed,
      issueCodes: qa.issueCodes,
      issues: qa.issues,
    };
    attempts.push(receipt);
    budget.record(qa.passed);
    if (qa.passed) return { passed: true, path, modelResult, qa, attempts, circuitReason: null };
    previousIssues = qa.issues;
    if (!budget.canAttempt().allowed) break;
  }
  const last = attempts.at(-1);
  return {
    passed: false,
    attempts,
    qa: last ? { version: 1, passed: false, issueCodes: last.issueCodes, issues: last.issues } : failureQa('thumbnail-generation-not-attempted', 'Aucune tentative possible'),
    circuitReason: budget.openReason,
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
