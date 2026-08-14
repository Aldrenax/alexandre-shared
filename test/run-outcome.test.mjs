import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MediaEngine } from '../media/engine.mjs';
import { classifyRunOutcome } from '../media/run-outcome.mjs';
import { MediaStateStore } from '../media/state-store.mjs';

function healthAfterRun(receipt) {
  const store = new MediaStateStore(mkdtempSync(join(tmpdir(), 'media-run-outcome-')));
  store.initialize();
  store.write('source-health', {
    version: 1,
    updatedAt: new Date().toISOString(),
    sources: {
      required: { sourceId: 'required', required: true, status: 'healthy' },
    },
  });
  store.recordRun('run', receipt);
  return new MediaEngine({ store }).healthReport();
}

test('cycle productif: les reports éditoriaux restent informatifs et la santé reste saine', () => {
  const outcome = classifyRunOutcome('run', {
    drafts: [{ candidateId: 'published-candidate', qa: { passed: true } }],
    attempts: [
      { mediaSlug: 'tesla-tech', candidateId: 'published-candidate', status: 'qa-passed' },
      { mediaSlug: 'chaimbault', candidateId: 'deferred-a', status: 'retryable-failure', reason: 'corroboration-accessible-insuffisante' },
      { mediaSlug: 'chaimbault', candidateId: 'deferred-b', status: 'retryable-failure', reason: 'preuve-source-inaccessible' },
      { mediaSlug: 'chaimbault', candidateId: 'deferred-c', status: 'retryable-failure', reason: 'source-officielle-inaccessible' },
    ],
  });

  assert.equal(outcome.receipt.status, 'success');
  assert.equal(outcome.receipt.candidateDeferrals.length, 3);
  assert.equal(outcome.receipt.candidateRetries, undefined);
  const health = healthAfterRun(outcome.receipt);
  assert.equal(health.status, 'healthy');
  assert.deepEqual(health.warnings, []);
});

test('cycle réseau: une exception technique reste un warning', () => {
  const outcome = classifyRunOutcome('run', {
    attempts: [{
      mediaSlug: 'chaimbault',
      candidateId: 'technical-failure',
      status: 'retryable-failure',
      reason: 'fetch failed: ETIMEDOUT',
    }],
  });

  assert.equal(outcome.receipt.status, 'warning');
  assert.equal(outcome.receipt.candidateRetries.length, 1);
  assert.equal(outcome.receipt.candidateDeferrals, undefined);
  const health = healthAfterRun(outcome.receipt);
  assert.equal(health.status, 'degraded');
  assert.deepEqual(health.warnings, ['last-network-run-warning']);
});

test('cycle réseau: un échec QA reste degraded', () => {
  const outcome = classifyRunOutcome('run', {
    attempts: [{
      mediaSlug: 'entreprise',
      candidateId: 'qa-failure',
      status: 'qa-failed',
      reason: 'banner-missing',
    }],
  });

  assert.equal(outcome.receipt.status, 'degraded');
  assert.equal(outcome.receipt.qaFailures.length, 1);
  const health = healthAfterRun(outcome.receipt);
  assert.equal(health.status, 'degraded');
  assert.deepEqual(health.blockers, ['last-network-run-degraded']);
});
