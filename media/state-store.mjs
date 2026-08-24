import {
  existsSync,
  readdirSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';

const QUEUE_KINDS = new Set([
  'candidates',
  'qualified',
  'drafts',
  'events',
  'caption-requests',
  'newsletter-attribution',
  'publication-ready',
  'publication-verification',
  'publication-failed',
]);

function ensureDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o750 });
}

export function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(path, value) {
  ensureDir(dirname(path));
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
  renameSync(temporary, path);
}

export function assertQueueKind(kind) {
  if (!QUEUE_KINDS.has(kind)) throw new Error(`File inconnue: ${kind}`);
  return kind;
}

function safeQueueId(id) {
  return String(id).replace(/[^a-z0-9._-]/gi, '-').slice(0, 160);
}

export class MediaStateStore {
  constructor(runtimeDir = process.env.MEDIA_ENGINE_RUNTIME_DIR || '/var/lib/alexandre-media-engine') {
    this.runtimeDir = resolve(runtimeDir);
    this.stateDir = join(this.runtimeDir, 'state');
    this.queueDir = join(this.runtimeDir, 'queue');
    this.draftsDir = join(this.runtimeDir, 'drafts');
    this.assetsDir = resolve(process.env.MEDIA_ENGINE_ASSETS_DIR || join(this.runtimeDir, 'assets'));
    this.locksDir = join(this.runtimeDir, 'locks');
  }

  initialize() {
    for (const path of [this.stateDir, this.queueDir, this.draftsDir, this.assetsDir, this.locksDir]) ensureDir(path);
  }

  path(name) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`Nom d’état invalide: ${name}`);
    return join(this.stateDir, `${name}.json`);
  }

  read(name, fallback = {}) {
    return readJson(this.path(name), fallback);
  }

  write(name, value) {
    writeJsonAtomic(this.path(name), value);
    return value;
  }

  update(name, updater, fallback = {}) {
    const current = this.read(name, fallback);
    return this.write(name, updater(current));
  }

  hasEvent(key) {
    return Boolean(this.getEvent(key));
  }

  getEvent(key) {
    return this.read('events', { version: 1, events: {} }).events?.[key] || null;
  }

  markEvent(key, receipt = {}) {
    return this.update('events', (current) => ({
      version: 1,
      updatedAt: new Date().toISOString(),
      events: {
        ...(current.events || {}),
        [key]: {
          at: new Date().toISOString(),
          ...receipt,
        },
      },
    }), { version: 1, events: {} });
  }

  recordRun(command, receipt = {}) {
    return this.update('last-runs', (current) => ({
      version: 1,
      updatedAt: new Date().toISOString(),
      runs: {
        ...(current.runs || {}),
        [command]: {
          at: new Date().toISOString(),
          ...receipt,
        },
      },
    }), { version: 1, runs: {} });
  }

  queuePath(kind, id) {
    assertQueueKind(kind);
    return join(this.queueDir, kind, `${safeQueueId(id)}.json`);
  }

  enqueue(kind, id, payload) {
    assertQueueKind(kind);
    const directory = join(this.queueDir, kind);
    ensureDir(directory);
    const path = this.queuePath(kind, id);
    writeJsonAtomic(path, payload);
    return path;
  }

  removeQueueEntry(kind, id) {
    const path = this.queuePath(kind, id);
    if (existsSync(path)) rmSync(path, { force: true });
    return path;
  }

  enqueuePublicationReady(draftPath, draft, { now = new Date() } = {}) {
    if (!draft?.qa?.passed || draft?.publicationEligibility?.status !== 'eligible') return null;
    const queueId = `${draft.mediaSlug}-${draft.contentType}-${draft.slug}`;
    const path = this.queuePath('publication-ready', queueId);
    const existing = readJson(path, null);
    return this.enqueue('publication-ready', queueId, {
      version: 1,
      queueId,
      mediaSlug: draft.mediaSlug,
      contentType: draft.contentType,
      candidateId: draft.candidateId,
      slug: draft.slug,
      title: draft.title,
      draftPath,
      scheduledPublishAt: draft.scheduledPublishAt || null,
      qualificationProfile: draft.candidateQualification?.profile || 'strict',
      queuedAt: existing?.queuedAt || now.toISOString(),
      attempts: Number(existing?.attempts || 0),
      nextAttemptAt: existing?.nextAttemptAt || null,
    });
  }

  listQueueEntries(kind) {
    assertQueueKind(kind);
    const directory = join(this.queueDir, kind);
    if (!existsSync(directory)) return [];
    const invalidJson = Symbol('invalid-json');
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => {
        const path = join(directory, entry.name);
        const payload = readJson(path, invalidJson);
        if (payload === invalidJson) return null;
        return { path, payload, mtimeMs: statSync(path).mtimeMs };
      })
      .filter(Boolean)
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  upsertObserved(kind, id, payload, { now = new Date() } = {}) {
    assertQueueKind(kind);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Payload d\u2019observation invalide');
    }
    const observedAt = now instanceof Date ? now : new Date(now);
    if (!Number.isFinite(observedAt.getTime())) throw new Error('Date d\u2019observation invalide');
    const path = this.queuePath(kind, id);
    const existing = readJson(path, null);
    const firstSeenAt = existing && typeof existing === 'object' && !Array.isArray(existing)
      ? existing.firstSeenAt
      : null;
    ensureDir(dirname(path));
    writeJsonAtomic(path, {
      ...payload,
      firstSeenAt: firstSeenAt || payload.firstSeenAt || observedAt.toISOString(),
      lastSeenAt: observedAt.toISOString(),
    });
    return path;
  }

  saveDraft(mediaSlug, draft) {
    const directory = join(this.draftsDir, mediaSlug);
    ensureDir(directory);
    const safeId = String(draft.candidateId).replace(/[^a-z0-9._-]/gi, '-').slice(0, 160);
    const path = join(directory, `${safeId}-${draft.contentType}.json`);
    writeJsonAtomic(path, draft);
    return path;
  }

  listDraftPaths(mediaSlug = null) {
    if (!existsSync(this.draftsDir)) return [];
    const mediaDirectories = mediaSlug ? [mediaSlug] : readdirSync(this.draftsDir);
    return mediaDirectories.flatMap((slug) => {
      const directory = join(this.draftsDir, slug);
      if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
      return readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .map((name) => join(directory, name));
    }).sort();
  }

  listDrafts(mediaSlug = null) {
    return this.listDraftPaths(mediaSlug)
      .map((path) => ({ path, draft: readJson(path, null) }))
      .filter((entry) => entry.draft && typeof entry.draft === 'object');
  }

  acquireLease(name, { ttlMs = 30 * 60_000, now = Date.now() } = {}) {
    this.initialize();
    const lockPath = join(this.locksDir, `${name}.lock`);
    if (existsSync(lockPath)) {
      const age = now - statSync(lockPath).mtimeMs;
      if (age <= ttlMs) return null;
      rmSync(lockPath, { recursive: true, force: true });
    }
    try {
      mkdirSync(lockPath, { mode: 0o750 });
    } catch (error) {
      if (error?.code === 'EEXIST') return null;
      throw error;
    }
    const owner = {
      host: hostname(),
      pid: process.pid,
      acquiredAt: new Date(now).toISOString(),
      ttlMs,
    };
    writeJsonAtomic(join(lockPath, 'owner.json'), owner);
    return { name, lockPath, owner };
  }

  releaseLease(lease) {
    if (!lease?.lockPath || !lease.lockPath.startsWith(this.locksDir)) throw new Error('Lease invalide');
    rmSync(lease.lockPath, { recursive: true, force: true });
  }
}
