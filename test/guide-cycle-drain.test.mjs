import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MediaEngine } from '../media/engine.mjs';
import { MediaStateStore } from '../media/state-store.mjs';

const offers = [{
  id: 'active-offer',
  name: 'Offre active',
  url: 'https://example.test/offre',
  status: 'active',
  channels: ['logiciels'],
}];

function opportunity(id, priorityScore) {
  return {
    id,
    mediaSlug: 'logiciels',
    title: `Guide ${id}`,
    offerId: 'active-offer',
    priorityScore,
    demandEvidence: { googleMonthlySearches: 100 },
    sources: [{
      id: `source-${id}`,
      title: `Source ${id}`,
      url: `https://source.test/${id}`,
      official: true,
      excerpt: 'Preuve détaillée et vérifiable.',
    }],
  };
}

function engineFixture() {
  const store = new MediaStateStore(mkdtempSync(join(tmpdir(), 'media-guide-drain-')));
  store.initialize();
  const generated = [];
  const engine = new MediaEngine({
    store,
    offers,
    enrichCandidateEvidenceImpl: async (candidate) => candidate,
  });
  engine.generateDraft = async (candidate) => {
    generated.push(candidate.id);
    return { candidateId: candidate.id, qa: { passed: true } };
  };
  return { engine, generated, store };
}

test('guide: une opportunité prioritaire déjà traitée laisse place à la suivante', async () => {
  const { engine, generated, store } = engineFixture();
  store.markEvent('guide-draft:logiciels:first', {
    status: 'qa-passed',
    candidateId: 'guide-first',
  });

  const result = await engine.runGuideCycle({
    mediaSlug: 'logiciels',
    opportunities: [opportunity('first', 100), opportunity('second', 80), opportunity('third', 60)],
  });

  assert.deepEqual(generated, ['guide-second']);
  assert.equal(result.length, 1);
  assert.equal(result[0].opportunityId, 'second');
  assert.deepEqual(result[0].processedOpportunityIds, ['first']);
  assert.equal(store.getEvent('guide-draft:logiciels:second').status, 'qa-passed');
  assert.equal(store.getEvent('guide-draft:logiciels:third'), null);
});

test('guide: le cycle reste borné à un guide par site même avec plusieurs opportunités neuves', async () => {
  const { engine, generated, store } = engineFixture();
  const result = await engine.runGuideCycle({
    mediaSlug: 'logiciels',
    opportunities: [opportunity('first', 100), opportunity('second', 80)],
  });

  assert.deepEqual(generated, ['guide-first']);
  assert.equal(result.length, 1);
  assert.equal(result[0].opportunityId, 'first');
  assert.equal(store.getEvent('guide-draft:logiciels:first').status, 'qa-passed');
  assert.equal(store.getEvent('guide-draft:logiciels:second'), null);
});

test('guide dry-run: la prochaine opportunité non traitée est annoncée sans génération', async () => {
  const { engine, generated, store } = engineFixture();
  store.markEvent('guide-draft:logiciels:first', { status: 'qa-passed' });

  const result = await engine.runGuideCycle({
    mediaSlug: 'logiciels',
    opportunities: [opportunity('first', 100), opportunity('second', 80)],
    dryRun: true,
  });

  assert.deepEqual(generated, []);
  assert.equal(result[0].planned, true);
  assert.equal(result[0].opportunity.id, 'second');
  assert.deepEqual(result[0].processedOpportunityIds, ['first']);
});

test('guide: un brouillon existant sans reçu est classé puis la file continue', async () => {
  const { engine, generated, store } = engineFixture();
  engine.generateDraft = async (candidate) => {
    generated.push(candidate.id);
    if (candidate.id === 'guide-first') {
      return {
        status: 'blocked',
        reason: 'duplicate-draft:same-primary-url',
        duplicateDraftPath: '/drafts/logiciels/guide-first.json',
      };
    }
    return { candidateId: candidate.id, qa: { passed: true } };
  };

  const result = await engine.runGuideCycle({
    mediaSlug: 'logiciels',
    opportunities: [opportunity('first', 100), opportunity('second', 80)],
  });

  assert.deepEqual(generated, ['guide-first', 'guide-second']);
  assert.equal(result[0].opportunityId, 'second');
  assert.deepEqual(result[0].processedOpportunityIds, ['first']);
  const receipt = store.getEvent('guide-draft:logiciels:first');
  assert.equal(receipt.status, 'duplicate-draft');
  assert.equal(receipt.reason, 'duplicate-draft:same-primary-url');
  assert.equal(receipt.path, '/drafts/logiciels/guide-first.json');
  assert.equal(receipt.candidateId, 'guide-first');
});

test('guide: un article déjà publié est classé puis la file continue', async () => {
  const { engine, generated, store } = engineFixture();
  engine.generateDraft = async (candidate) => {
    generated.push(candidate.id);
    if (candidate.id === 'guide-first') {
      return {
        status: 'blocked',
        reason: 'already-published-or-similar',
        publishedPath: '/guides/guide-first/',
      };
    }
    return { candidateId: candidate.id, qa: { passed: true } };
  };

  const result = await engine.runGuideCycle({
    mediaSlug: 'logiciels',
    opportunities: [opportunity('first', 100), opportunity('second', 80)],
  });

  assert.deepEqual(generated, ['guide-first', 'guide-second']);
  assert.equal(result[0].opportunityId, 'second');
  assert.deepEqual(result[0].processedOpportunityIds, ['first']);
  const receipt = store.getEvent('guide-draft:logiciels:first');
  assert.equal(receipt.status, 'already-published');
  assert.equal(receipt.reason, 'already-published-or-similar');
  assert.equal(receipt.path, '/guides/guide-first/');
});

test('guide: le lease couvre toute la génération, mais pas le dry-run', async () => {
  const { engine, store } = engineFixture();
  let releaseGeneration;
  let signalGenerationStarted;
  const generationStarted = new Promise((resolve) => { signalGenerationStarted = resolve; });
  const generationGate = new Promise((resolve) => { releaseGeneration = resolve; });
  engine.generateDraft = async (candidate) => {
    signalGenerationStarted();
    await generationGate;
    return { candidateId: candidate.id, qa: { passed: true } };
  };
  const contender = new MediaEngine({
    store,
    offers,
    enrichCandidateEvidenceImpl: async (candidate) => candidate,
  });
  contender.generateDraft = async () => {
    throw new Error('la seconde génération ne doit pas démarrer');
  };

  const firstRun = engine.runGuideCycle({
    mediaSlug: 'logiciels',
    opportunities: [opportunity('first', 100)],
  });
  await generationStarted;
  try {
    const blocked = await contender.runGuideCycle({
      mediaSlug: 'logiciels',
      opportunities: [opportunity('first', 100)],
    });
    assert.deepEqual(blocked, [{ mediaSlug: 'logiciels', skipped: true, reason: 'guide-lease-active' }]);

    const planned = await contender.runGuideCycle({
      mediaSlug: 'logiciels',
      opportunities: [opportunity('first', 100)],
      dryRun: true,
    });
    assert.equal(planned[0].planned, true);
  } finally {
    releaseGeneration();
    await firstRun;
  }
});

test('guide: une erreur réelle remonte et libère le lease', async () => {
  const { engine, store } = engineFixture();
  engine.generateDraft = async () => {
    throw new Error('panne réelle');
  };

  await assert.rejects(
    engine.runGuideCycle({ mediaSlug: 'logiciels', opportunities: [opportunity('first', 100)] }),
    /panne réelle/,
  );
  const lease = store.acquireLease('guide-cycle');
  assert.ok(lease);
  store.releaseLease(lease);
});
