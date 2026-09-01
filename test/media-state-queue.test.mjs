import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertQueueKind, MediaStateStore } from '../media/state-store.mjs';

test('files d\u2019\u00e9tat: les types autoris\u00e9s sont valid\u00e9s au m\u00eame endroit', () => {
  const store = new MediaStateStore(mkdtempSync(join(tmpdir(), 'media-state-kind-')));
  assert.equal(assertQueueKind('qualified'), 'qualified');
  assert.throws(() => assertQueueKind('inconnue'), /File inconnue/);
  assert.throws(() => store.enqueue('inconnue', 'id', {}), /File inconnue/);
  assert.throws(() => store.listQueueEntries('inconnue'), /File inconnue/);
  assert.throws(() => store.upsertObserved('inconnue', 'id', {}), /File inconnue/);
});

test('files d\u2019\u00e9tat: la lecture retourne uniquement les fichiers JSON valides', () => {
  const root = mkdtempSync(join(tmpdir(), 'media-state-list-'));
  const store = new MediaStateStore(root);
  store.enqueue('qualified', 'b', { id: 'b', status: 'qualified' });
  store.enqueue('qualified', 'a', { id: 'a', status: 'qualified' });
  const directory = join(store.queueDir, 'qualified');
  writeFileSync(join(directory, 'malformed.json'), '{pas-json');
  writeFileSync(join(directory, 'ignore.txt'), '{"id":"texte"}');
  mkdirSync(join(directory, 'directory.json'));

  const entries = store.listQueueEntries('qualified');
  assert.deepEqual(entries.map((entry) => entry.payload.id), ['a', 'b']);
  assert.ok(entries.every((entry) => entry.path.endsWith('.json')));
  assert.ok(entries.every((entry) => Number.isFinite(entry.mtimeMs)));
});

test('files d\u2019\u00e9tat: upsertObserved conserve firstSeenAt et rafra\u00eechit lastSeenAt', () => {
  const store = new MediaStateStore(mkdtempSync(join(tmpdir(), 'media-state-observed-')));
  const first = new Date('2026-08-14T08:00:00.000Z');
  const second = new Date('2026-08-14T09:30:00.000Z');
  const path = store.upsertObserved('candidates', 'source:item', {
    id: 'item',
    title: 'Premi\u00e8re observation',
  }, { now: first });
  store.upsertObserved('candidates', 'source:item', {
    id: 'item',
    title: 'Observation actualis\u00e9e',
  }, { now: second });

  const payload = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(payload.title, 'Observation actualis\u00e9e');
  assert.equal(payload.firstSeenAt, first.toISOString());
  assert.equal(payload.lastSeenAt, second.toISOString());
  assert.throws(
    () => store.upsertObserved('candidates', 'invalid-payload', null, { now: second }),
    /Payload d\u2019observation invalide/,
  );
  assert.throws(
    () => store.upsertObserved('candidates', 'invalid-date', {}, { now: 'date-invalide' }),
    /Date d\u2019observation invalide/,
  );
});

test('files d\u2019\u00e9tat: un brouillon qualifi\u00e9 entre imm\u00e9diatement dans la file de publication', () => {
  const store = new MediaStateStore(mkdtempSync(join(tmpdir(), 'media-state-publication-')));
  const now = new Date('2026-08-24T09:00:00.000Z');
  const draft = {
    mediaSlug: 'chaimbault',
    contentType: 'news',
    candidateId: 'candidate-42',
    slug: 'publication-directe',
    title: 'Publication directe',
    qa: { passed: true },
    publicationEligibility: { status: 'eligible' },
    candidateQualification: { profile: 'fallback' },
  };
  const draftPath = store.saveDraft('chaimbault', draft);
  const entryPath = store.enqueuePublicationReady(draftPath, draft, { now });
  assert.ok(entryPath?.endsWith('chaimbault-news-publication-directe.json'));
  const [entry] = store.listQueueEntries('publication-ready');
  assert.equal(entry.payload.draftPath, draftPath);
  assert.equal(entry.payload.qualificationProfile, 'fallback');
  assert.equal(entry.payload.queuedAt, now.toISOString());
  assert.equal(store.enqueuePublicationReady(draftPath, { ...draft, qa: { passed: false } }), null);
});

test('verrous d\u2019\u00e9tat: un PID local mort est repris imm\u00e9diatement sans attendre le TTL et reste token-safe', () => {
  const store = new MediaStateStore(mkdtempSync(join(tmpdir(), 'media-state-lease-owner-')));
  const now = Date.now();
  const first = store.acquireLease('owner-safe', { ttlMs: 1_000, now });
  assert.ok(first);
  writeFileSync(join(first.lockPath, 'owner.json'), `${JSON.stringify({
    ...first.owner,
    pid: 2_147_483_647,
  })}\n`);
  const second = store.acquireLease('owner-safe', { ttlMs: 1_000, now });
  assert.ok(second);
  assert.notEqual(second.owner.token, first.owner.token);
  assert.throws(() => store.releaseLease(first), /d\u00e9tenue par un autre processus/);
  assert.equal(store.acquireLease('owner-safe', { ttlMs: 1_000, now }), null);
  assert.equal(store.releaseLease(second), true);
});

test('verrous d\u2019\u00e9tat: un owner vivant reste prot\u00e9 au-del\u00e0 du TTL', () => {
  const store = new MediaStateStore(mkdtempSync(join(tmpdir(), 'media-state-live-owner-')));
  const now = Date.now();
  const owner = store.acquireLease('live-owner', { ttlMs: 1_000, now });
  utimesSync(owner.lockPath, new Date(now - 5_000), new Date(now - 5_000));
  assert.equal(store.acquireLease('live-owner', { ttlMs: 1_000, now }), null);
  assert.equal(store.releaseLease(owner), true);
  const successor = store.acquireLease('live-owner', { ttlMs: 1_000, now });
  assert.ok(successor);
  assert.equal(store.releaseLease(successor), true);
});

test('verrous d\u2019\u00e9tat: un crash avant rename du lock ou du recovery ne laisse aucun blocage ownerless', () => {
  const store = new MediaStateStore(mkdtempSync(join(tmpdir(), 'media-state-candidate-crash-')));
  store.initialize();
  const lockPath = join(store.locksDir, 'candidate-crash.lock');
  mkdirSync(`${lockPath}.candidate-dead-process-token`, { mode: 0o750 });
  mkdirSync(`${lockPath}.recovery.candidate-dead-process-token`, { mode: 0o750 });
  const lease = store.acquireLease('candidate-crash');
  assert.ok(lease);
  assert.equal(store.releaseLease(lease), true);
});

test('verrous d\u2019\u00e9tat: les locks legacy ownerless non vides sont prot\u00e9g\u00e9s pendant la gr\u00e2ce puis r\u00e9cup\u00e9r\u00e9s', () => {
  const store = new MediaStateStore(mkdtempSync(join(tmpdir(), 'media-state-ownerless-legacy-')));
  store.initialize();
  const now = Date.now();
  const lockPath = join(store.locksDir, 'legacy-ownerless.lock');
  mkdirSync(lockPath, { mode: 0o750 });
  writeFileSync(join(lockPath, 'owner.json.crash.tmp'), 'incomplete', { mode: 0o640 });
  assert.equal(store.acquireLease('legacy-ownerless', { ttlMs: 13 * 60 * 60_000, now }), null);
  const recovered = store.acquireLease('legacy-ownerless', {
    ttlMs: 13 * 60 * 60_000,
    now: now + 31_000,
  });
  assert.ok(recovered);
  assert.equal(store.releaseLease(recovered), true);
});

test('verrous d\u2019\u00e9tat: un recovery legacy ownerless non vide est repris apr\u00e8s la gr\u00e2ce', () => {
  const store = new MediaStateStore(mkdtempSync(join(tmpdir(), 'media-state-ownerless-recovery-')));
  const now = Date.now();
  const first = store.acquireLease('ownerless-recovery', { ttlMs: 13 * 60 * 60_000, now });
  writeFileSync(join(first.lockPath, 'owner.json'), `${JSON.stringify({
    ...first.owner,
    pid: 2_147_483_647,
  })}\n`);
  const recoveryPath = `${first.lockPath}.recovery`;
  mkdirSync(recoveryPath, { mode: 0o750 });
  writeFileSync(join(recoveryPath, 'owner.json.crash.tmp'), 'incomplete', { mode: 0o640 });
  assert.equal(store.acquireLease('ownerless-recovery', { ttlMs: 13 * 60 * 60_000, now }), null);
  const recovered = store.acquireLease('ownerless-recovery', {
    ttlMs: 13 * 60 * 60_000,
    now: now + 31_000,
  });
  assert.ok(recovered);
  assert.equal(existsSync(recoveryPath), false);
  assert.equal(store.releaseLease(recovered), true);
});

test('verrous d\u2019\u00e9tat: une r\u00e9cup\u00e9ration abandonn\u00e9e et expir\u00e9e ne bloque pas le circuit', () => {
  const store = new MediaStateStore(mkdtempSync(join(tmpdir(), 'media-state-lease-recovery-')));
  const now = Date.now();
  const first = store.acquireLease('recovery-safe', { ttlMs: 1_000, now });
  const recoveryPath = `${first.lockPath}.recovery`;
  mkdirSync(recoveryPath, { mode: 0o750 });
  writeFileSync(join(first.lockPath, 'owner.json'), `${JSON.stringify({
    ...first.owner,
    pid: 2_147_483_647,
  })}\n`);
  writeFileSync(join(recoveryPath, 'owner.json'), `${JSON.stringify({
    host: first.owner.host,
    pid: 2_147_483_647,
    token: 'abandoned-recovery',
  })}\n`);
  const staleDate = new Date(now - 2_000);
  utimesSync(first.lockPath, staleDate, staleDate);
  utimesSync(recoveryPath, staleDate, staleDate);

  const recovered = store.acquireLease('recovery-safe', { ttlMs: 1_000, now });
  assert.ok(recovered);
  assert.equal(existsSync(recoveryPath), false);
  assert.throws(() => store.releaseLease(first), /d\u00e9tenue par un autre processus/);
  assert.equal(store.releaseLease(recovered), true);
});
