import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chownSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { officialThumbnailAssets } from './thumbnail-policy.mjs';

export const DEFAULT_EDITORIAL_PROVIDER = 'openai-codex';
export const DEFAULT_EDITORIAL_MODEL = 'gpt-5.6-terra';
const DEFAULT_HERMES_VISION_STAGING_HOST_ROOT = '/var/lib/hermes-agent/media-engine';
const DEFAULT_HERMES_VISION_STAGING_CONTAINER_ROOT = '/opt/data/media-engine';

function numericDockerOwnership(env = process.env) {
  const explicitUid = String(env.HERMES_VISION_STAGING_UID || '').trim();
  const explicitGid = String(env.HERMES_VISION_STAGING_GID || '').trim();
  const dockerUser = String(env.HERMES_DOCKER_USER || '').trim();
  const [dockerUid = '', dockerGid = dockerUid] = dockerUser.split(':', 2);
  const uidText = explicitUid || dockerUid;
  const gidText = explicitGid || dockerGid;
  if (!/^\d+$/u.test(uidText) || !/^\d+$/u.test(gidText)) return null;
  return { uid: Number.parseInt(uidText, 10), gid: Number.parseInt(gidText, 10) };
}

function defaultHermesCommand(env = process.env) {
  if (env.HERMES_COMMAND_JSON) {
    const parsed = JSON.parse(env.HERMES_COMMAND_JSON);
    if (!Array.isArray(parsed) || !parsed.length) throw new Error('HERMES_COMMAND_JSON doit être un tableau non vide');
    return parsed.map(String);
  }
  const dockerUser = String(env.HERMES_DOCKER_USER || '').trim();
  return [
    env.DOCKER_BIN || '/usr/bin/docker',
    'exec',
    '-i',
    ...(dockerUser ? ['--user', dockerUser] : []),
    env.HERMES_CONTAINER || 'hermes-agent',
    env.HERMES_BIN || '/opt/hermes/.venv/bin/hermes',
  ];
}

const STDIN_ONESHOT_PYTHON = [
  'import sys',
  'prompt = sys.stdin.read()',
  'sys.argv = ["hermes", "--oneshot", prompt, *sys.argv[1:]]',
  'from hermes_cli.main import main',
  'main()',
].join('; ');

function supportsStdinOneshot(command) {
  return /(?:^|\/)docker$/.test(String(command?.[0] || ''))
    && /(?:^|\/)hermes$/.test(String(command?.at?.(-1) || ''));
}

export function parseJsonPayload(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('Hermes a retourné une réponse vide');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || text;
  try {
    return JSON.parse(candidate);
  } catch {
    const firstObject = candidate.indexOf('{');
    const lastObject = candidate.lastIndexOf('}');
    if (firstObject >= 0 && lastObject > firstObject) return JSON.parse(candidate.slice(firstObject, lastObject + 1));
    const firstArray = candidate.indexOf('[');
    const lastArray = candidate.lastIndexOf(']');
    if (firstArray >= 0 && lastArray > firstArray) return JSON.parse(candidate.slice(firstArray, lastArray + 1));
    throw new Error(`Réponse Hermes non JSON: ${candidate.slice(0, 240)}`);
  }
}

function execute(command, args, {
  cwd,
  env,
  input = null,
  timeoutMs = 300_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stdin.on('error', () => {});
    child.stdin.end(input == null ? '' : String(input));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Hermes timeout après ${timeoutMs} ms`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(new Error(`Hermes exit ${code}: ${stderr.slice(-1_500) || stdout.slice(-500)}`));
    });
  });
}

export class HermesClient {
  constructor({
    command = defaultHermesCommand(),
    cwd = process.cwd(),
    env = {},
    executeImpl = execute,
    promptTransport = null,
  } = {}) {
    this.command = command;
    this.cwd = cwd;
    this.env = { ...process.env, ...env };
    this.executeImpl = executeImpl;
    this.promptTransport = promptTransport
      || this.env.HERMES_PROMPT_TRANSPORT
      || (supportsStdinOneshot(command) ? 'stdin' : 'argv');
  }

  editorialOptions({ contentType = 'news', image = false } = {}) {
    const guide = contentType === 'guide';
    return {
      provider: this.env.HERMES_EDITORIAL_PROVIDER || DEFAULT_EDITORIAL_PROVIDER,
      model: image
        ? this.env.HERMES_IMAGE_ORCHESTRATOR_MODEL || this.env.HERMES_EDITORIAL_MODEL || DEFAULT_EDITORIAL_MODEL
        : guide
          ? this.env.HERMES_GUIDE_MODEL || this.env.HERMES_EDITORIAL_MODEL || DEFAULT_EDITORIAL_MODEL
          : this.env.HERMES_EDITORIAL_MODEL || DEFAULT_EDITORIAL_MODEL,
    };
  }

  async oneshot(prompt, {
    model = null,
    provider = null,
    reasoning = null,
    toolsets = null,
    timeoutMs = 300_000,
  } = {}) {
    const [command, ...prefix] = this.command;
    const options = [];
    if (model) options.push('--model', model);
    if (provider) options.push('--provider', provider);
    if (reasoning) options.push('--reasoning', reasoning);
    if (toolsets) options.push('--toolsets', Array.isArray(toolsets) ? toolsets.join(',') : toolsets);
    let args;
    let input = null;
    if (this.promptTransport === 'stdin') {
      if (!supportsStdinOneshot(this.command)) {
        throw new Error('Transport stdin Hermes disponible uniquement avec docker exec');
      }
      const hermesBin = prefix.at(-1);
      const dockerPrefix = prefix.slice(0, -1);
      if (!dockerPrefix.includes('-i')) dockerPrefix.splice(1, 0, '-i');
      args = [
        ...dockerPrefix,
        hermesBin.replace(/\/hermes$/, '/python3'),
        '-c',
        STDIN_ONESHOT_PYTHON,
        ...options,
      ];
      input = prompt;
    } else {
      args = [...prefix, '--oneshot', prompt, ...options];
    }
    const result = await this.executeImpl(command, args, {
      cwd: this.cwd,
      env: this.env,
      input,
      timeoutMs,
    });
    return result.stdout.trim();
  }

  async oneshotJson(prompt, options = {}) {
    const output = await this.oneshot([
      prompt,
      '',
      'CONTRAT DE SORTIE: retourne uniquement un JSON valide, sans Markdown, préambule ni commentaire.',
    ].join('\n'), options);
    return parseJsonPayload(output);
  }

  async authList() {
    const [command, ...prefix] = this.command;
    const result = await this.executeImpl(command, [...prefix, 'auth', 'list'], {
      cwd: this.cwd,
      env: this.env,
      timeoutMs: 60_000,
    });
    const raw = result.stdout.trim();
    const providers = [...new Set(
      raw.split('\n')
        .map((line) => line.match(/(?:^|\s)([a-z0-9][a-z0-9._-]*(?:-oauth)?)(?:\s|$)/i)?.[1]?.toLowerCase())
        .filter(Boolean),
    )];
    return { raw, providers };
  }

  async toolList() {
    const [command, ...prefix] = this.command;
    const result = await this.executeImpl(command, [...prefix, 'tools', 'list'], {
      cwd: this.cwd,
      env: this.env,
      timeoutMs: 60_000,
    });
    return result.stdout.trim();
  }

  async configGet(key) {
    const [command, ...prefix] = this.command;
    const result = await this.executeImpl(command, [...prefix, 'config', 'get', key], {
      cwd: this.cwd,
      env: this.env,
      timeoutMs: 60_000,
    });
    return result.stdout.trim();
  }

  async xSearch({
    query,
    allowedHandles = [],
    excludedHandles = [],
    fromDate = '',
    toDate = '',
    mediaSlug,
  }) {
    if (!query?.trim()) throw new Error('query x_search requise');
    if (allowedHandles.length && excludedHandles.length) throw new Error('allowedHandles et excludedHandles sont incompatibles');
    const filters = {
      allowed_x_handles: allowedHandles.map((value) => String(value).replace(/^@/, '')),
      excluded_x_handles: excludedHandles.map((value) => String(value).replace(/^@/, '')),
      from_date: fromDate,
      to_date: toDate,
    };
    const payload = await this.oneshotJson([
      `Tu effectues une recherche X pour le média ${mediaSlug || 'réseau'}.`,
      `Utilise impérativement l'outil x_search une seule fois avec la requête et les filtres exacts suivants.`,
      `Requête: ${query}`,
      `Filtres JSON: ${JSON.stringify(filters)}`,
      `N'utilise pas ta mémoire comme source. Un post avec une URL X directe constitue une preuve traçable.`,
      `Marque degraded=true uniquement si ni citations ni posts ne contiennent d'URL exploitable.`,
      `Schéma: {"query":"...","answer":"...","citations":[{"url":"...","title":"..."}],"posts":[{"url":"...","author":"...","publishedAt":null,"summary":"...","official":false}],"degraded":false,"degradedReason":null}`,
    ].join('\n'), {
      provider: this.env.HERMES_EDITORIAL_PROVIDER || DEFAULT_EDITORIAL_PROVIDER,
      model: this.env.HERMES_RESEARCH_MODEL || this.env.HERMES_EDITORIAL_MODEL || DEFAULT_EDITORIAL_MODEL,
      reasoning: 'medium',
      toolsets: ['x_search'],
      timeoutMs: 240_000,
    });
    const posts = Array.isArray(payload.posts)
      ? payload.posts.filter((post) => /^https?:\/\//.test(post?.url || ''))
      : [];
    const explicitCitations = Array.isArray(payload.citations)
      ? payload.citations.filter((citation) => /^https?:\/\//.test(citation?.url || ''))
      : [];
    const citations = explicitCitations.length ? explicitCitations : posts.map((post) => ({
      url: post.url,
      title: post.summary || post.author || post.url,
    }));
    const degraded = citations.length === 0;
    return {
      ...payload,
      query,
      posts,
      citations,
      degraded,
      degradedReason: degraded ? payload.degradedReason || 'x_search sans citation exploitable' : null,
      observedAt: new Date().toISOString(),
      sourceId: 'x-search',
    };
  }

  async generateEditorialJson(prompt, { contentType = 'news' } = {}) {
    const guide = contentType === 'guide';
    return this.oneshotJson(prompt, {
      ...this.editorialOptions({ contentType }),
      reasoning: guide ? 'high' : 'medium',
      timeoutMs: guide ? 900_000 : 600_000,
    });
  }

  async generateBannerJson(prompt) {
    return this.oneshotJson(prompt, {
      ...this.editorialOptions({ image: true }),
      reasoning: 'medium',
      toolsets: ['image_gen'],
      timeoutMs: 600_000,
    });
  }

  async inspectThumbnailJson({ path, media, draft, inspection }) {
    const normalizedPath = resolve(String(path || ''));
    if (!existsSync(normalizedPath)) throw new Error('Miniature normalisée introuvable pour Hermes vision');
    const bytes = readFileSync(normalizedPath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (!inspection?.sha256 || inspection.sha256 !== sha256) {
      throw new Error('La miniature a changé avant l’inspection Hermes vision');
    }

    const hostRoot = resolve(this.env.HERMES_VISION_STAGING_HOST_ROOT || DEFAULT_HERMES_VISION_STAGING_HOST_ROOT);
    const containerRoot = String(
      this.env.HERMES_VISION_STAGING_CONTAINER_ROOT || DEFAULT_HERMES_VISION_STAGING_CONTAINER_ROOT,
    ).replace(/\/+$/u, '');
    const relativeName = join('thumbnail-qa', `${sha256}-${process.pid}-${randomUUID()}.webp`);
    const stagedHostPath = join(hostRoot, relativeName);
    const temporaryPath = `${stagedHostPath}.tmp`;
    const stagedContainerPath = `${containerRoot}/${relativeName.replaceAll('\\', '/')}`;
    const stagingDirectory = dirname(stagedHostPath);
    const ownership = numericDockerOwnership(this.env);
    mkdirSync(stagingDirectory, { recursive: true, mode: 0o750 });
    if (ownership) chownSync(stagingDirectory, ownership.uid, ownership.gid);

    try {
      // The host service runs as root while Hermes runs under its unprivileged
      // container uid. Ownership is transferred before the atomic rename so
      // the transient image can stay private to root and Hermes.
      writeFileSync(temporaryPath, bytes, { mode: 0o640 });
      if (ownership) chownSync(temporaryPath, ownership.uid, ownership.gid);
      renameSync(temporaryPath, stagedHostPath);
      const expectedText = String(draft?.bannerBrief?.headline || '').trim();
      const officialAssets = officialThumbnailAssets(draft);
      const payload = await this.oneshotJson([
        'Tu es le second contrôleur visuel indépendant d’une miniature déjà générée et normalisée.',
        `Média contrôlé: ${media?.name || media?.slug || draft?.mediaSlug || 'inconnu'}.`,
        `Utilise impérativement l’outil vision exactement une fois sur ce fichier local: ${stagedContainerPath}`,
        'Inspecte les pixels de ce fichier final. N’utilise et ne répète aucune auto-déclaration du générateur.',
        `SHA-256 de référence calculé par le moteur: ${sha256}`,
        `Dimensions finales attendues: 1280x720. Headline exact attendu: ${expectedText || '(aucun texte)'}.`,
        'Évalue la transcription exacte, tout rognage, la lisibilité à 360 px de large et les éléments de marque ou humains réellement visibles.',
        'Si un headline est présent, fournis sa boîte englobante normalisée entre 0 et 1 sous la forme left/top/right/bottom. Utilise null si aucun texte n’est visible.',
        `Assets officiels déterministes autorisés (liste vide = aucun logo, interface ou visage): ${JSON.stringify(officialAssets)}.`,
        'Si l’image ne peut pas être ouverte ou si un champ ne peut pas être vérifié, retourne success=false. Ne devine jamais.',
        'Schéma exact: {"success":true,"observedText":"","textExact":true,"textClipped":false,"mobileReadable":true,"textBoundingBox":null,"usesLogo":false,"usesInterface":false,"usesFace":false,"notes":[]}',
      ].join('\n'), {
        provider: this.env.HERMES_VISION_PROVIDER || this.env.HERMES_EDITORIAL_PROVIDER || DEFAULT_EDITORIAL_PROVIDER,
        model: this.env.HERMES_VISION_MODEL || this.env.HERMES_EDITORIAL_MODEL || DEFAULT_EDITORIAL_MODEL,
        reasoning: 'medium',
        toolsets: ['vision'],
        timeoutMs: 300_000,
      });
      return {
        ...payload,
        method: 'hermes-vision',
        independent: true,
        sha256,
        checkedAt: new Date().toISOString(),
      };
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      if (existsSync(stagedHostPath)) unlinkSync(stagedHostPath);
    }
  }
}

export { defaultHermesCommand };
