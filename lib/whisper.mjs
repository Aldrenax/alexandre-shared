/**
 * Local Whisper transcription (no API cost).
 *
 * Pipeline:
 *   yt-dlp → mp3 mono 64kbps → python3 transcribe.py → text
 *
 * Backend: faster-whisper (CTranslate2 + Whisper) running on CPU. Free.
 *
 * Requires on PATH:
 *   - yt-dlp
 *   - ffmpeg
 *   - python3 (with faster-whisper installed: pip install faster-whisper)
 *
 * Env vars:
 *   - WHISPER_MODEL   (default: small) — model size: tiny|base|small|medium|large-v3|large-v3-turbo
 *   - WHISPER_COMPUTE (default: int8)  — CTranslate2 compute type
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRANSCRIBE_SCRIPT = resolve(__dirname, 'transcribe.py');
const PROXY_SESSION_ID = randomBytes(4).toString('hex');

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

export function transcriptCachePath(videoId, env = process.env) {
  const root = String(env.WHISPER_TRANSCRIPT_CACHE_DIR || '').trim();
  if (!root) return null;
  if (!/^[A-Za-z0-9_-]{6,32}$/.test(String(videoId || ''))) throw new Error('Identifiant YouTube invalide pour le cache');
  return join(root, `${videoId}.txt`);
}

export function readCachedTranscript(videoId, env = process.env) {
  const path = transcriptCachePath(videoId, env);
  if (!path || !existsSync(path)) return '';
  const transcript = readFileSync(path, 'utf8').trim();
  return transcript.length >= 500 ? transcript : '';
}

export function writeCachedTranscript(videoId, transcript, env = process.env) {
  const path = transcriptCachePath(videoId, env);
  const value = String(transcript || '').trim();
  if (!path || value.length < 500) return null;
  mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${value}\n`, { mode: 0o640 });
  renameSync(temporary, path);
  return path;
}

function run(cmd, args, { timeout = 1_800_000, captureStdout = false, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stderr = '';
    let stdout = '';
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      // Stream meaningful progress lines (prefixed [transcribe]) so cron logs stay informative.
      for (const line of s.split('\n')) {
        if (line.startsWith('[transcribe]')) console.log('  ' + line);
      }
    });
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error(`${cmd} timeout`));
    }, timeout);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exit ${code}\n${stderr.slice(-2000)}`));
    });
  });
}

function which(bin) {
  return new Promise((resolve) => {
    const p = spawn('which', [bin]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', (code) => resolve(code === 0 && out.trim().length > 0));
  });
}

async function pythonHasFasterWhisper() {
  return new Promise((resolve) => {
    const p = spawn('python3', ['-c', 'import faster_whisper; print("ok")']);
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('close', (code) => resolve(code === 0 && out.includes('ok')));
  });
}

export async function checkWhisperReady() {
  return {
    'yt-dlp': await which('yt-dlp'),
    ffmpeg: await which('ffmpeg'),
    python3: await which('python3'),
    'faster-whisper': await pythonHasFasterWhisper(),
  };
}

export function stickyProxyUrl(rawProxyUrl, sessionId = PROXY_SESSION_ID) {
  const proxyUrl = String(rawProxyUrl || '').trim();
  if (!proxyUrl) return '';
  const parsed = new URL(proxyUrl);
  if (parsed.hostname.endsWith('.iproyal.com') && !decodeURIComponent(parsed.password).includes('_session-')) {
    if (!/^[a-z0-9]{8}$/i.test(sessionId)) throw new Error('Identifiant de session proxy invalide');
    parsed.password = `${decodeURIComponent(parsed.password)}_session-${sessionId}_lifetime-2h`;
  }
  return parsed.toString();
}

export function ytDlpNetworkEnv(env = process.env, sessionId = PROXY_SESSION_ID) {
  const proxyUrl = stickyProxyUrl(env.HTTP_PROXY_URL, sessionId);
  if (!proxyUrl) return env;
  return {
    ...env,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    all_proxy: proxyUrl,
  };
}

function directNetworkEnv(env = process.env) {
  const direct = { ...env };
  for (const key of [
    'HTTP_PROXY_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy',
  ]) delete direct[key];
  return direct;
}

export async function runYtDlpWithRetries(args, {
  timeout = 120_000,
  captureStdout = false,
  env = process.env,
  attempts = Math.max(1, Number(env.YTDLP_ATTEMPTS || 3)),
  allowDirectFallback = String(env.YTDLP_ALLOW_DIRECT_FALLBACK || '').toLowerCase() === 'true',
  runImpl = run,
  waitImpl = wait,
} = {}) {
  const errors = [];
  const plans = Array.from({ length: attempts }, () => ({ direct: false }));
  if (allowDirectFallback && env.HTTP_PROXY_URL) plans.push({ direct: true });
  for (const [index, plan] of plans.entries()) {
    const attemptEnv = plan.direct
      ? directNetworkEnv(env)
      : ytDlpNetworkEnv(env, randomBytes(4).toString('hex'));
    try {
      return await runImpl('yt-dlp', args, { timeout, captureStdout, env: attemptEnv });
    } catch (error) {
      errors.push(plan.direct ? `direct: ${error.message}` : `proxy-${index + 1}: ${error.message}`);
      if (index < plans.length - 1) await waitImpl(Math.min(4_000, 500 * (2 ** index)));
    }
  }
  throw new Error(`yt-dlp indisponible après ${plans.length} tentatives\n${errors.join('\n')}`);
}

export async function ytDlpVideoMetadata(videoId) {
  const cookiesPath = resolve(process.cwd(), '.youtube-cookies.txt');
  const cookieArgs = existsSync(cookiesPath) ? ['--cookies', cookiesPath] : [];
  const { stdout } = await runYtDlpWithRetries([
    '--dump-single-json',
    '--skip-download',
    '--no-warnings',
    '--remote-components', 'ejs:github',
    ...cookieArgs,
    `https://www.youtube.com/watch?v=${videoId}`,
  ], { timeout: 120_000, captureStdout: true });
  return JSON.parse(stdout);
}

/**
 * Download audio for a YouTube video and transcribe it locally via faster-whisper.
 * Returns the transcript text (concatenated segments).
 */
export async function whisperTranscribe(videoId, { language = 'fr' } = {}) {
  const cached = readCachedTranscript(videoId);
  if (cached) {
    console.log(`  [whisper] cached transcript = ${videoId}`);
    return cached;
  }
  const bins = await checkWhisperReady();
  const missing = Object.entries(bins).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) throw new Error(`Missing for local Whisper: ${missing.join(', ')}`);

  const workDir = join(tmpdir(), `whisper-${videoId}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  const audioPath = join(workDir, 'audio.mp3');

  try {
    console.log(`  [whisper] yt-dlp → audio…`);
    // YouTube anti-bot on cloud egress IPs requires (a) auth cookies, and
    // (b) a JS runtime + n-sig solver script (--remote-components ejs:github
    // pulls the solver from yt-dlp/ejs). No --extractor-args needed when
    // authenticated: yt-dlp auto-picks the best client and we get full audio
    // format list.
    const cookiesPath = resolve(process.cwd(), '.youtube-cookies.txt');
    const cookieArgs = existsSync(cookiesPath) ? ['--cookies', cookiesPath] : [];
    await runYtDlpWithRetries([
      '-f', 'bestaudio',
      '--no-playlist',
      '--no-warnings',
      '--remote-components', 'ejs:github',
      ...cookieArgs,
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '64K',
      '--postprocessor-args', '-ac 1', // mono
      '-o', audioPath,
      `https://www.youtube.com/watch?v=${videoId}`,
    ], { timeout: 480_000 });

    if (!existsSync(audioPath)) throw new Error('yt-dlp produced no audio file');
    const audioSize = statSync(audioPath).size;
    console.log(`  [whisper] audio = ${(audioSize / 1024 / 1024).toFixed(2)} MB`);

    console.log(`  [whisper] transcribing locally with faster-whisper…`);
    const model = process.env.WHISPER_MODEL || 'base';
    const { stdout } = await run('python3', [TRANSCRIBE_SCRIPT, audioPath, language, model], {
      timeout: 1_800_000,
      env: {
        ...process.env,
        OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || '2',
        MKL_NUM_THREADS: process.env.MKL_NUM_THREADS || '2',
        MALLOC_ARENA_MAX: process.env.MALLOC_ARENA_MAX || '2',
      },
    });
    const transcript = stdout.trim();
    writeCachedTranscript(videoId, transcript);
    return transcript;
  } finally {
    try {
      for (const f of readdirSync(workDir)) {
        try { unlinkSync(join(workDir, f)); } catch {}
      }
      try { rmdirSync(workDir); } catch {}
    } catch {}
  }
}
