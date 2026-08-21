import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  activateWordPressDraftSite,
  activationPlan,
  updatedEnvironmentText,
} from '../media/wordpress-draft-activation.mjs';

function fixtureEnv(root) {
  const envFile = join(root, 'wordpress-shadow.env');
  writeFileSync(envFile, [
    'WORDPRESS_DRAFT_BASE_URL=https://alexandrechaimbault.com/',
    'WORDPRESS_DRAFT_USERNAME=hermes',
    'WORDPRESS_DRAFT_APPLICATION_PASSWORD=secret-value',
    '',
  ].join('\n'), { mode: 0o640 });
  return envFile;
}

function healthyFetch(siteKey = 'affiliation', blogId = 5) {
  return async () => new Response(JSON.stringify({
    status: 'ok',
    site_key: siteKey,
    blog_id: blogId,
    publication_mode: 'draft-only',
    can_publish: false,
    can_delete: false,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('activation WordPress: le plan respecte strictement l’ordre canari', () => {
  const first = activationPlan({
    env: { WORDPRESS_DRAFT_MEDIA_SLUGS: 'chaimbault' },
    mediaSlug: 'affiliation',
    siteUrl: 'https://alexandre-affiliation.fr/',
    expectedBlogId: 5,
  });
  assert.deepEqual(first.nextSlugs, ['chaimbault', 'affiliation']);
  assert.throws(() => activationPlan({
    env: { WORDPRESS_DRAFT_MEDIA_SLUGS: 'chaimbault' },
    mediaSlug: 'logiciels',
    siteUrl: 'https://alexandre-logiciels.fr/',
    expectedBlogId: 6,
  }), /hors séquence/u);
});

test('activation WordPress: le mode lecture seule prouve la santé sans modifier le secret', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wordpress-activation-plan-'));
  const envFile = fixtureEnv(root);
  const before = readFileSync(envFile, 'utf8');
  const result = await activateWordPressDraftSite({
    envFile,
    mediaSlug: 'affiliation',
    siteUrl: 'https://alexandre-affiliation.fr/',
    expectedBlogId: 5,
    fetchImpl: healthyFetch(),
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.applied, false);
  assert.equal(readFileSync(envFile, 'utf8'), before);
  assert.doesNotMatch(JSON.stringify(result), /secret-value/u);
});

test('activation WordPress: l’écriture est atomique, bornée et sauvegardée', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wordpress-activation-apply-'));
  const envFile = fixtureEnv(root);
  const result = await activateWordPressDraftSite({
    envFile,
    mediaSlug: 'affiliation',
    siteUrl: 'https://alexandre-affiliation.fr/',
    expectedBlogId: 5,
    apply: true,
    fetchImpl: healthyFetch(),
    now: () => new Date('2026-08-22T00:30:00.000Z'),
  });
  assert.equal(result.status, 'activated');
  assert.equal(result.applied, true);
  assert.ok(existsSync(result.backupPath));
  const updated = readFileSync(envFile, 'utf8');
  assert.match(updated, /WORDPRESS_DRAFT_APPLICATION_PASSWORD=secret-value/u);
  assert.match(updated, /WORDPRESS_DRAFT_MEDIA_SLUGS=chaimbault,affiliation/u);
  assert.match(updated, /WORDPRESS_DRAFT_SITE_URLS_JSON='\{"affiliation":"https:\/\/alexandre-affiliation\.fr\/"\}'/u);
  assert.doesNotMatch(JSON.stringify(result), /secret-value/u);
});

test('activation WordPress: le texte remplace uniquement les deux clés non secrètes', () => {
  const plan = {
    nextSlugs: ['chaimbault', 'affiliation'],
    nextOverrides: { affiliation: 'https://alexandre-affiliation.fr/' },
  };
  const result = updatedEnvironmentText([
    '# keep',
    'WORDPRESS_DRAFT_APPLICATION_PASSWORD=secret',
    'WORDPRESS_DRAFT_MEDIA_SLUGS=chaimbault',
    'WORDPRESS_DRAFT_SITE_URLS_JSON=\'{}\'',
    '',
  ].join('\n'), plan);
  assert.match(result, /^# keep/mu);
  assert.match(result, /^WORDPRESS_DRAFT_APPLICATION_PASSWORD=secret$/mu);
  assert.equal((result.match(/^WORDPRESS_DRAFT_MEDIA_SLUGS=/gmu) || []).length, 1);
  assert.equal((result.match(/^WORDPRESS_DRAFT_SITE_URLS_JSON=/gmu) || []).length, 1);
});
