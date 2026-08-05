import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const MESSAGE_LIMIT = 4_096;

export function readTopicState(path = process.env.HERMES_TELEGRAM_TOPIC_STATE_PATH || '/var/lib/hermes-agent/telegram-cockpit/state.json') {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function resolveTopicId(topicName, state) {
  const value = state?.topics?.[topicName];
  return Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
}

export function splitMessage(text, limit = MESSAGE_LIMIT) {
  const chunks = [];
  let remaining = String(text || '').trim();
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = remaining.lastIndexOf(' ', limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function exec(command, args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('hermes send timeout'));
    }, timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`hermes send exit ${code}: ${stderr.slice(-800)}`));
    });
  });
}

export class HermesTelegramRouter {
  constructor({
    topicStatePath,
    chatId = process.env.TELEGRAM_CHAT_ID,
    command = [
      process.env.DOCKER_BIN || '/usr/bin/docker',
      'exec',
      process.env.HERMES_CONTAINER || 'hermes-agent',
      process.env.HERMES_BIN || '/opt/hermes/.venv/bin/hermes',
    ],
    executeImpl = exec,
  } = {}) {
    this.topicStatePath = topicStatePath;
    this.chatId = chatId;
    this.command = command;
    this.executeImpl = executeImpl;
  }

  async send({ topicName, text, mediaPath = null, dryRun = false }) {
    const state = readTopicState(this.topicStatePath);
    const threadId = resolveTopicId(topicName, state);
    const chunks = splitMessage(text);
    if (!threadId) throw new Error(`Topic Hermes introuvable: ${topicName}`);
    if (!this.chatId) throw new Error('TELEGRAM_CHAT_ID manquant pour hermes send');
    if (dryRun) return { dryRun: true, topicName, threadId, chunks, mediaPath };

    const [command, ...prefix] = this.command;
    const receipts = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const attachment = index === 0 && mediaPath ? `\nMEDIA:${mediaPath}` : '';
      const target = `telegram:${this.chatId}:${threadId}`;
      const output = await this.executeImpl(command, [
        ...prefix,
        'send',
        '--json',
        '--to',
        target,
        `${chunks[index]}${attachment}`,
      ]);
      let receipt = output;
      try { receipt = JSON.parse(output); } catch {}
      receipts.push(receipt);
    }
    return { dryRun: false, topicName, threadId, receipts };
  }
}

export function buildPublishedMessage({ media, draft, publicUrl }) {
  return [
    `📝 Nouvel article · ${media.name}`,
    '',
    draft.title,
    `Rubrique : ${draft.section}`,
    publicUrl,
  ].join('\n');
}

