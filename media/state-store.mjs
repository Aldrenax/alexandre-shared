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
import { randomUUID } from 'node:crypto';
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
  'thumbnail-refresh',
]);

function ensureDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o750 });
}

const LOCK_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(milliseconds) {
  Atomics.wait(LOCK_SLEEP_BUFFER, 0, 0, Math.max(1, milliseconds));
}

function safeLockName(name) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`Nom de verrou invalide: ${name}`);
  return name;
}

function localOwnerIsDead(owner) {
  if (!owner || owner.host !== hostname()) return false;
  const pid = Number(owner.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error?.code === 'ESRCH') return true;
    // EPERM prouve aussi qu'un processus occupe encore ce PID. Toute erreur
    // inconnue reste fail-closed : un verrou vivant ne doit jamais être repris.
    return false;
  }
}

function installOwnedDirectory(targetPath, owner) {
  const candidatePath = `${targetPath}.candidate-${process.pid}-${owner.token}`;
  mkdirSync(candidatePath, { mode: 0o750 });
  try {
    writeJsonAtomic(join(candidatePath, 'owner.json'), owner);
    try {
      // Le répertoire et son owner deviennent visibles en une seule opération.
      // Un kill avant le rename ne laisse qu'un candidat unique et non bloquant.
      renameSync(candidatePath, targetPath);
      return true;
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EISDIR'].includes(error?.code)) throw error;
      return false;
    }
  } finally {
    if (existsSync(candidatePath)) rmSync(candidatePath, { recursive: true, force: true });
  }
}

function retireOwnedDirectory(targetPath, token) {
  const currentOwner = readJson(join(targetPath, 'owner.json'), null);
  if (!currentOwner?.token || currentOwner.token !== token) return false;
  const retiredPath = `${targetPath}.retired-${process.pid}-${token}`;
  try {
    // Détacher atomiquement notre génération avant de la supprimer. Un
    // successeur peut alors installer son propre répertoire au chemin canonique
    // sans que le nettoyage récursif ne touche jamais ses fichiers.
    renameSync(targetPath, retiredPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  const retiredOwner = readJson(join(retiredPath, 'owner.json'), null);
  if (retiredOwner?.token !== token) {
    if (!existsSync(targetPath)) renameSync(retiredPath, targetPath);
    return false;
  }
  rmSync(retiredPath, { recursive: true, force: true });
  return true;
}

function ownsDirectory(targetPath, token) {
  return readJson(join(targetPath, 'owner.json'), null)?.token === token;
}

function ownerlessDirectoryIsStale(targetPath, observedAt, graceMs) {
  if (readJson(join(targetPath, 'owner.json'), null)) return false;
  try {
    return observedAt - statSync(targetPath).mtimeMs > graceMs;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function retireOwnerlessDirectory(targetPath, observedAt, graceMs) {
  if (!ownerlessDirectoryIsStale(targetPath, observedAt, graceMs)) return false;
  const retiredPath = `${targetPath}.ownerless-retired-${process.pid}-${randomUUID()}`;
  try {
    renameSync(targetPath, retiredPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  // Revalider après le rename ferme la course avec un ancien writer qui aurait
  // posé owner.json pendant la grâce. Dans ce cas, ne jamais le supprimer.
  if (readJson(join(retiredPath, 'owner.json'), null)) {
    if (!existsSync(targetPath)) renameSync(retiredPath, targetPath);
    return false;
  }
  rmSync(retiredPath, { recursive: true, force: true });
  return true;
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

  updateLocked(name, updater, fallback = {}, {
    lockName = `state-${name}`,
    ttlMs = 30_000,
    timeoutMs = 30_000,
  } = {}) {
    return this.withExclusiveLock(lockName, () => this.update(name, updater, fallback), {
      ttlMs,
      timeoutMs,
    });
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

  draftPath(mediaSlug, draft) {
    const safeId = String(draft.candidateId).replace(/[^a-z0-9._-]/gi, '-').slice(0, 160);
    return join(this.draftsDir, mediaSlug, `${safeId}-${draft.contentType}.json`);
  }

  saveDraft(mediaSlug, draft) {
    const path = this.draftPath(mediaSlug, draft);
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
    const leaseName = safeLockName(name);
    const lockPath = join(this.locksDir, `${leaseName}.lock`);
    const observedAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const token = randomUUID();
    const owner = {
      host: hostname(),
      pid: process.pid,
      token,
      acquiredAt: new Date(observedAt).toISOString(),
      ttlMs,
    };
    const recoveryPath = `${lockPath}.recovery`;
    const ownerlessGraceMs = Math.min(Math.max(1_000, Number(ttlMs) || 30_000), 30_000);

    // Ne jamais entrer pendant qu'un récupérateur a déjà déplacé l'ancien
    // lease. Un prétendant ayant passé ce test juste avant le guard reste sûr :
    // son rename atomique gagnera, et le récupérateur ne supprimera pas ce
    // nouveau propriétaire.
    if (existsSync(recoveryPath)) {
      const staleRecoveryOwner = readJson(join(recoveryPath, 'owner.json'), null);
      // Un PID local confirmé mort est une preuve plus forte que le TTL : le
      // prochain timer peut reprendre immédiatement après un crash. Un owner
      // vivant ou distant reste au contraire protégé indéfiniment. Un verrou
      // legacy sans owner devient récupérable après une grâce de 30 s maximum.
      if (localOwnerIsDead(staleRecoveryOwner)) {
        if (!retireOwnedDirectory(recoveryPath, staleRecoveryOwner.token)) return null;
      } else if (!retireOwnerlessDirectory(recoveryPath, observedAt, ownerlessGraceMs)) {
        return null;
      }
    }
    if (installOwnedDirectory(lockPath, owner)) {
      return { name: leaseName, lockPath, owner };
    }

    {

      const observedOwner = readJson(join(lockPath, 'owner.json'), null);
      const observedOwnerDead = localOwnerIsDead(observedOwner);
      const observedOwnerlessStale = !observedOwner
        && ownerlessDirectoryIsStale(lockPath, observedAt, ownerlessGraceMs);
      if (!observedOwnerDead && !observedOwnerlessStale) return null;

      // Une seule instance peut récupérer un verrou expiré. Sans ce second
      // verrou, deux processus pourraient supprimer le nouveau propriétaire
      // entre l'observation de l'ancien verrou et sa mise en quarantaine.
      const recoveryOwnerPath = join(recoveryPath, 'owner.json');
      const recoveryOwner = {
        host: hostname(),
        pid: process.pid,
        token,
        acquiredAt: new Date(observedAt).toISOString(),
      };
      if (!installOwnedDirectory(recoveryPath, recoveryOwner)) {
        const currentRecoveryOwner = readJson(recoveryOwnerPath, null);
        if (localOwnerIsDead(currentRecoveryOwner)) {
          if (!retireOwnedDirectory(recoveryPath, currentRecoveryOwner.token)) return null;
        } else if (!retireOwnerlessDirectory(recoveryPath, observedAt, ownerlessGraceMs)) {
          return null;
        }
        if (!installOwnedDirectory(recoveryPath, recoveryOwner)) return null;
      }
      let stalePath = null;
      try {
        if (!ownsDirectory(recoveryPath, recoveryOwner.token)) return null;
        const currentOwner = readJson(join(lockPath, 'owner.json'), null);
        const currentOwnerMatches = observedOwnerDead
          ? currentOwner?.token === observedOwner.token && localOwnerIsDead(currentOwner)
          : !currentOwner && ownerlessDirectoryIsStale(lockPath, observedAt, ownerlessGraceMs);
        if (!currentOwnerMatches) return null;
        stalePath = `${lockPath}.stale-${process.pid}-${token}`;
        try {
          renameSync(lockPath, stalePath);
        } catch (renameError) {
          if (renameError?.code === 'ENOENT') return null;
          throw renameError;
        }
        const movedOwner = readJson(join(stalePath, 'owner.json'), null);
        const movedOwnerMatches = observedOwnerDead
          ? movedOwner?.token === observedOwner.token
          : !movedOwner;
        if (!movedOwnerMatches || !ownsDirectory(recoveryPath, recoveryOwner.token)) {
          if (!existsSync(lockPath)) renameSync(stalePath, lockPath);
          stalePath = null;
          return null;
        }
        rmSync(stalePath, { recursive: true, force: true });
        stalePath = null;
        if (!ownsDirectory(recoveryPath, recoveryOwner.token)) return null;
        if (!installOwnedDirectory(lockPath, owner)) return null;
        return { name: leaseName, lockPath, owner };
      } finally {
        if (stalePath && existsSync(stalePath) && !existsSync(lockPath)) {
          renameSync(stalePath, lockPath);
        }
        retireOwnedDirectory(recoveryPath, recoveryOwner.token);
      }
    }
  }

  releaseLease(lease) {
    if (!lease?.lockPath || !lease.lockPath.startsWith(this.locksDir)) throw new Error('Lease invalide');
    if (!existsSync(lease.lockPath)) return false;
    if (!retireOwnedDirectory(lease.lockPath, lease.owner?.token)) {
      throw new Error(`Lease ${lease.name || 'inconnue'} détenue par un autre processus`);
    }
    return true;
  }

  withExclusiveLock(name, callback, {
    ttlMs = 30_000,
    timeoutMs = 30_000,
    retryDelayMs = 10,
  } = {}) {
    if (typeof callback !== 'function') throw new Error('Callback de verrou requis');
    const startedAt = Date.now();
    let lease = null;
    do {
      lease = this.acquireLease(name, { ttlMs });
      if (lease) break;
      if (Date.now() - startedAt >= timeoutMs) {
        const error = new Error(`Délai dépassé pour le verrou ${name}`);
        error.code = 'MEDIA_STATE_LOCK_TIMEOUT';
        throw error;
      }
      sleepSync(Math.min(retryDelayMs, Math.max(1, timeoutMs - (Date.now() - startedAt))));
    } while (!lease);

    try {
      const result = callback(lease);
      if (result && typeof result.then === 'function') {
        throw new Error('Le callback de verrou doit être synchrone');
      }
      return result;
    } finally {
      this.releaseLease(lease);
    }
  }
}
