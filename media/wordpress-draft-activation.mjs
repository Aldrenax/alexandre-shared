import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  copyFileSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { loadEnvironmentFile } from './environment.mjs';
import {
  enabledWordPressMediaSlugs,
  endpointOrigin,
  WordPressDraftClient,
  WORDPRESS_TARGETS,
} from './wordpress-draft-publisher.mjs';

export const WORDPRESS_DRAFT_ACTIVATION_SEQUENCE = Object.freeze([
  Object.freeze({ mediaSlug: 'affiliation', siteKey: 'affiliation', blogId: 5 }),
  Object.freeze({ mediaSlug: 'logiciels', siteKey: 'logiciels', blogId: 6 }),
  Object.freeze({ mediaSlug: 'entreprise', siteKey: 'entreprise', blogId: 4 }),
  Object.freeze({ mediaSlug: 'tesla-tech', siteKey: 'tesla', blogId: 2 }),
  Object.freeze({ mediaSlug: 'investissement', siteKey: 'investissement', blogId: 3 }),
]);

function parseOverrides(value) {
  if (!value) return {};
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error('WORDPRESS_DRAFT_SITE_URLS_JSON doit être un objet JSON valide'); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('WORDPRESS_DRAFT_SITE_URLS_JSON doit être un objet JSON valide');
  }
  return parsed;
}

export function activationPlan({ env, mediaSlug, siteUrl, expectedBlogId }) {
  const next = WORDPRESS_DRAFT_ACTIVATION_SEQUENCE.find((entry) => entry.mediaSlug === mediaSlug);
  if (!next) throw new Error(`Média WordPress non activable: ${mediaSlug || '(vide)'}`);
  if (Number(expectedBlogId) !== next.blogId) throw new Error(`Blog ID inattendu pour ${mediaSlug}`);
  const normalizedSiteUrl = endpointOrigin(siteUrl);
  const expectedUrl = `https://${WORDPRESS_TARGETS[mediaSlug].domain}/`;
  if (normalizedSiteUrl !== expectedUrl) throw new Error(`URL finale inattendue pour ${mediaSlug}`);

  const currentSlugs = enabledWordPressMediaSlugs(env);
  const nextIndex = WORDPRESS_DRAFT_ACTIVATION_SEQUENCE.findIndex((entry) => entry.mediaSlug === mediaSlug);
  const expectedCurrentSlugs = [
    'chaimbault',
    ...WORDPRESS_DRAFT_ACTIVATION_SEQUENCE.slice(0, nextIndex).map((entry) => entry.mediaSlug),
  ];
  if (JSON.stringify(currentSlugs) !== JSON.stringify(expectedCurrentSlugs)) {
    throw new Error(`Activation WordPress hors séquence pour ${mediaSlug}`);
  }

  const currentOverrides = parseOverrides(env.WORDPRESS_DRAFT_SITE_URLS_JSON);
  const nextOverrides = { ...currentOverrides, [mediaSlug]: normalizedSiteUrl };
  const nextSlugs = [...currentSlugs, mediaSlug];
  return {
    mediaSlug,
    siteKey: next.siteKey,
    blogId: next.blogId,
    siteUrl: normalizedSiteUrl,
    currentSlugs,
    nextSlugs,
    nextOverrides,
  };
}

export function updatedEnvironmentText(source, plan) {
  const preserved = String(source || '')
    .split(/\r?\n/u)
    .filter((line) => !/^WORDPRESS_DRAFT_(?:MEDIA_SLUGS|SITE_URLS_JSON)=/u.test(line));
  while (preserved.length && preserved.at(-1) === '') preserved.pop();
  preserved.push(
    `WORDPRESS_DRAFT_MEDIA_SLUGS=${plan.nextSlugs.join(',')}`,
    `WORDPRESS_DRAFT_SITE_URLS_JSON='${JSON.stringify(plan.nextOverrides)}'`,
    '',
  );
  return preserved.join('\n');
}

async function proveDraftOnlySite({ env, plan, fetchImpl }) {
  const client = new WordPressDraftClient({
    baseUrl: plan.siteUrl,
    username: env.WORDPRESS_DRAFT_USERNAME,
    applicationPassword: env.WORDPRESS_DRAFT_APPLICATION_PASSWORD,
    fetchImpl,
  });
  const response = await client.health();
  const health = response.body || {};
  if (
    health.status !== 'ok'
    || health.site_key !== plan.siteKey
    || Number(health.blog_id || 0) !== plan.blogId
    || health.publication_mode !== 'draft-only'
    || health.can_publish !== false
    || health.can_delete !== false
  ) {
    throw new Error(`Le endpoint WordPress ${plan.siteKey} n’est pas en mode brouillon sûr`);
  }
  return {
    status: health.status,
    siteKey: health.site_key,
    blogId: Number(health.blog_id),
    publicationMode: health.publication_mode,
    canPublish: health.can_publish,
    canDelete: health.can_delete,
  };
}

export async function activateWordPressDraftSite({
  envFile,
  mediaSlug,
  siteUrl,
  expectedBlogId,
  apply = false,
  fetchImpl = fetch,
  now = () => new Date(),
} = {}) {
  if (!envFile) throw new Error('Fichier wordpress-shadow.env requis');
  const source = readFileSync(envFile, 'utf8');
  const env = loadEnvironmentFile(envFile, {}, { override: true });
  const plan = activationPlan({ env, mediaSlug, siteUrl, expectedBlogId });
  const health = await proveDraftOnlySite({ env, plan, fetchImpl });
  if (!apply) return { status: 'ready', applied: false, ...plan, health };

  const metadata = statSync(envFile);
  const stamp = now().toISOString().replaceAll(/[:.]/gu, '-');
  const backupPath = `${envFile}.backup-${stamp}`;
  copyFileSync(envFile, backupPath, 1);
  chmodSync(backupPath, metadata.mode & 0o777);
  chownSync(backupPath, metadata.uid, metadata.gid);

  const candidatePath = `${envFile}.candidate-${process.pid}-${randomUUID()}`;
  writeFileSync(candidatePath, updatedEnvironmentText(source, plan), { encoding: 'utf8', mode: metadata.mode & 0o777, flag: 'wx' });
  chownSync(candidatePath, metadata.uid, metadata.gid);
  renameSync(candidatePath, envFile);
  try {
    const appliedEnv = loadEnvironmentFile(envFile, {}, { override: true });
    await proveDraftOnlySite({ env: appliedEnv, plan, fetchImpl });
  } catch (error) {
    const rollbackPath = `${envFile}.rollback-${process.pid}-${randomUUID()}`;
    copyFileSync(backupPath, rollbackPath, 1);
    chmodSync(rollbackPath, metadata.mode & 0o777);
    chownSync(rollbackPath, metadata.uid, metadata.gid);
    renameSync(rollbackPath, envFile);
    throw new Error(`Activation WordPress annulée et configuration restaurée: ${error.message}`);
  }

  return { status: 'activated', applied: true, ...plan, health, backupPath };
}
