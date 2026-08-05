import { spawn } from 'node:child_process';

export const DEFAULT_EDITORIAL_PROVIDER = 'openai-codex';
export const DEFAULT_EDITORIAL_MODEL = 'gpt-5.6-terra';

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
    ...(dockerUser ? ['--user', dockerUser] : []),
    env.HERMES_CONTAINER || 'hermes-agent',
    env.HERMES_BIN || '/opt/hermes/.venv/bin/hermes',
  ];
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

function execute(command, args, { cwd, env, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
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
  } = {}) {
    this.command = command;
    this.cwd = cwd;
    this.env = { ...process.env, ...env };
    this.executeImpl = executeImpl;
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
    const args = [...prefix, '--oneshot', prompt];
    if (model) args.push('--model', model);
    if (provider) args.push('--provider', provider);
    if (reasoning) args.push('--reasoning', reasoning);
    if (toolsets) args.push('--toolsets', Array.isArray(toolsets) ? toolsets.join(',') : toolsets);
    const result = await this.executeImpl(command, args, {
      cwd: this.cwd,
      env: this.env,
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
}

export { defaultHermesCommand };
