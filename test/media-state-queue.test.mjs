import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
