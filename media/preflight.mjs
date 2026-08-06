import { readFileSync } from 'node:fs';
import { activeMedia, validateRegistry } from './registry.mjs';
import { loadSiteConfigs } from './publication-worker.mjs';
import { DEFAULT_EDITORIAL_MODEL, DEFAULT_EDITORIAL_PROVIDER } from './hermes-client.mjs';

const SYSTEM_TOPICS = ['✅ Décisions à valider', '🚨 Santé & incidents', '📊 Cockpit réseau', '✍️ Pilotage'];

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

function enabled(value) {
  return /^(?:1|true|yes)$/i.test(String(value || ''));
}

function check(id, passed, detail) {
  return { id, passed: Boolean(passed), detail };
}

function elapsedDays(value, now = new Date()) {
  const startedAt = Date.parse(value || '');
  return Number.isFinite(startedAt) ? Math.max(0, Math.floor((now.getTime() - startedAt) / 86_400_000)) : 0;
}

export async function runPreflight({
  hermes,
  env = process.env,
  runtimeHealth = null,
  topicStatePath = env.HERMES_TELEGRAM_TOPIC_STATE_PATH || '/var/lib/hermes-agent/telegram-cockpit/state.json',
  siteConfigs = null,
} = {}) {
  if (!hermes) throw new Error('HermesClient requis');
  const registryErrors = validateRegistry();
  const topicState = readJson(topicStatePath);
  const topicNames = new Set(Object.keys(topicState.topics || {}));
  const requiredTopics = [...activeMedia().map((media) => media.topicName), ...SYSTEM_TOPICS];
  const missingTopics = requiredTopics.filter((name) => !topicNames.has(name));
  const sites = siteConfigs || loadSiteConfigs(env.MEDIA_ENGINE_SITES_PATH);
  const missingSites = activeMedia().filter((media) => !sites[media.slug]?.repository).map((media) => media.slug);
  let auth = { raw: '', providers: [] };
  let authError = null;
  try { auth = await hermes.authList(); } catch (error) { authError = String(error?.message || error); }
  let toolsRaw = '';
  let imageModel = '';
  let imageError = null;
  try {
    toolsRaw = await hermes.toolList();
    imageModel = await hermes.configGet('image_gen.model');
  } catch (error) {
    imageError = String(error?.message || error);
  }
  const hasXai = auth.providers.includes('xai-oauth') || /\bxai-oauth\b/i.test(auth.raw);
  const editorialProvider = env.HERMES_EDITORIAL_PROVIDER || DEFAULT_EDITORIAL_PROVIDER;
  const editorialModel = env.HERMES_EDITORIAL_MODEL || DEFAULT_EDITORIAL_MODEL;
  const hasOpenAiCodex = auth.providers.includes('openai-codex') || /\bopenai-codex\b/i.test(auth.raw);
  const checks = [
    check('registry', registryErrors.length === 0, registryErrors),
    check('topics', missingTopics.length === 0, { missing: missingTopics }),
    check('sites', missingSites.length === 0, { missing: missingSites }),
    check('hermes-auth-list', !authError, authError || 'accessible'),
    check('chatgpt-provider', editorialProvider === 'openai-codex' && hasOpenAiCodex, {
      provider: editorialProvider,
      model: editorialModel,
      authenticated: hasOpenAiCodex,
    }),
    check('image-generation', !imageError && /enabled\s+image_gen\b/i.test(toolsRaw) && Boolean(imageModel), {
      enabled: /enabled\s+image_gen\b/i.test(toolsRaw),
      model: imageModel || null,
      error: imageError,
    }),
    check('safe-publication-mode', (env.MEDIA_ENGINE_PUBLICATION_MODE || 'draft') === 'draft', env.MEDIA_ENGINE_PUBLICATION_MODE || 'draft'),
  ];
  const readyForShadow = checks.every((entry) => entry.passed);
  const enrichmentChecks = [
    check('xai-oauth', hasXai, hasXai ? 'présent' : 'absent, RSS et sources officielles restent disponibles'),
  ];
  const publishingChecks = [
    check(
      'runtime-health',
      runtimeHealth?.status === 'healthy',
      runtimeHealth ? { status: runtimeHealth.status, blockers: runtimeHealth.blockers || [] } : 'absent',
    ),
    check('automatic-publication-approved', enabled(env.MEDIA_ENGINE_AUTOMATIC_PUBLICATION_APPROVED), env.MEDIA_ENGINE_AUTOMATIC_PUBLICATION_APPROVED || 'false'),
    check('git-push-enabled', enabled(env.MEDIA_ENGINE_PUSH_ENABLED), env.MEDIA_ENGINE_PUSH_ENABLED || 'false'),
    check(
      'shadow-period-complete',
      elapsedDays(env.MEDIA_ENGINE_SHADOW_STARTED_AT) >= Number(env.MEDIA_ENGINE_SHADOW_DAYS_REQUIRED || 7),
      {
        elapsedDays: elapsedDays(env.MEDIA_ENGINE_SHADOW_STARTED_AT),
        requiredDays: Number(env.MEDIA_ENGINE_SHADOW_DAYS_REQUIRED || 7),
      },
    ),
  ];
  return {
    version: 1,
    observedAt: new Date().toISOString(),
    readyForShadow,
    readyForFullResearch: readyForShadow && enrichmentChecks.every((entry) => entry.passed),
    readyForPublishing: readyForShadow && publishingChecks.every((entry) => entry.passed),
    checks,
    enrichmentChecks,
    publishingChecks,
  };
}
