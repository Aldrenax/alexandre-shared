import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const activationScript = fileURLToPath(new URL('../deploy/activate-publication.sh', import.meta.url));
const publisherTimer = 'alexandre-media-publish.timer';
const legacyTimers = [
  'tesla-tech-news.timer',
  'investissement-news.timer',
  'entreprise-news.timer',
  'affiliation-news.timer',
  'logiciels-news.timer',
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'activate-publication-'));
  const configDir = join(root, 'etc');
  const currentDir = join(root, 'current');
  const fakeBin = join(root, 'bin');
  const statePath = join(root, 'systemctl-state.json');
  const observedPath = join(root, 'curate-observed.env');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(currentDir, 'bin'), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });

  const oldPublicationEnv = [
    'MEDIA_ENGINE_PUBLICATION_MODE=automatic',
    'MEDIA_ENGINE_AUTOMATIC_PUBLICATION_APPROVED=true',
    'MEDIA_ENGINE_PUSH_ENABLED=true',
    'MEDIA_ENGINE_AUTOMATIC_CUTOVER_AT=2026-08-12T10:00:00Z',
    'MEDIA_ENGINE_PUBLICATION_DAILY_LIMIT=6',
    'MEDIA_ENGINE_PUBLICATION_PER_MEDIA_DAILY_LIMIT=1',
    'MEDIA_ENGINE_PUBLICATION_MIN_INTERVAL_MINUTES=90',
    '',
  ].join('\n');
  writeFileSync(join(configDir, 'media-engine.env'), 'MEDIA_ENGINE_NEWS_MAX_AGE_HOURS=72\n');
  writeFileSync(join(configDir, 'shadow.env'), 'MEDIA_ENGINE_SHADOW_STARTED_AT=2026-08-01T00:00:00Z\n');
  writeFileSync(join(configDir, 'publication.env'), oldPublicationEnv);

  const initialState = {
    'alexandre-media-engine-events.path': { enabled: true, active: true },
    [publisherTimer]: { enabled: true, active: true },
    [legacyTimers[0]]: { enabled: false, active: false },
    [legacyTimers[1]]: { enabled: true, active: false },
    [legacyTimers[2]]: { enabled: false, active: true },
    [legacyTimers[3]]: { enabled: true, active: true },
    [legacyTimers[4]]: { enabled: false, active: false },
  };
  writeFileSync(statePath, `${JSON.stringify(initialState, null, 2)}\n`);

  const fakeId = join(fakeBin, 'id');
  writeFileSync(fakeId, '#!/usr/bin/env bash\nif [[ "${1:-}" == "-u" ]]; then echo 0; else /usr/bin/id "$@"; fi\n');
  chmodSync(fakeId, 0o755);

  const fakeSystemctl = join(fakeBin, 'systemctl.mjs');
  writeFileSync(fakeSystemctl, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const statePath = process.env.SYSTEMCTL_STATE_PATH;
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const [action, ...args] = process.argv.slice(2);
const now = args.includes('--now');
const units = args.filter((value) => value !== '--quiet' && value !== '--now');
const unit = units[0];
const ensure = (name) => { state[name] ||= { enabled: false, active: false }; return state[name]; };
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + '\\n');
if (action === 'is-enabled') process.exit(ensure(unit).enabled ? 0 : 1);
if (action === 'is-active') process.exit(ensure(unit).active ? 0 : 3);
if (action === 'enable' && now && unit === '${publisherTimer}' && process.env.SYSTEMCTL_FAIL_ENABLE_NOW === '1') process.exit(1);
if (action === 'enable' && now && unit === '${publisherTimer}' && process.env.SYSTEMCTL_NOOP_ENABLE_NOW === '1') process.exit(0);
for (const name of units) {
  const item = ensure(name);
  if (action === 'enable') item.enabled = true;
  if (action === 'disable') item.enabled = false;
  if (action === 'start') item.active = true;
  if (action === 'stop') item.active = false;
  if (now && action === 'enable') item.active = true;
  if (now && action === 'disable') item.active = false;
}
save();
`);
  chmodSync(fakeSystemctl, 0o755);

  const fakeCli = join(currentDir, 'bin', 'media-engine.mjs');
  writeFileSync(fakeCli, `
import { readFileSync, writeFileSync } from 'node:fs';
const command = process.argv[2];
if (command === 'preflight') {
  console.log(JSON.stringify({ readyForPublishing: true }));
} else if (command === 'curate') {
  writeFileSync(process.env.CURATE_OBSERVED_PATH, readFileSync(process.env.MEDIA_ENGINE_CONFIG_DIR + '/publication.env'));
  if (process.env.CURATE_FAIL === '1') process.exit(17);
  console.log(JSON.stringify({ applied: true }));
} else {
  process.exit(2);
}
`);

  return {
    root,
    configDir,
    currentDir,
    fakeBin,
    fakeSystemctl,
    statePath,
    observedPath,
    initialState,
    oldPublicationEnv,
  };
}

function runActivation(value, extraEnv = {}) {
  return spawnSync('/bin/bash', [activationScript, '--apply', 'AUTOMATIC_PUBLICATION_APPROVED'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${value.fakeBin}:${process.env.PATH}`,
      MEDIA_ENGINE_CONFIG_DIR: value.configDir,
      MEDIA_ENGINE_CURRENT_DIR: value.currentDir,
      MEDIA_ENGINE_NODE_BIN: process.execPath,
      MEDIA_ENGINE_SYSTEMCTL_BIN: value.fakeSystemctl,
      SYSTEMCTL_STATE_PATH: value.statePath,
      CURATE_OBSERVED_PATH: value.observedPath,
      ...extraEnv,
    },
  });
}

function timerState(value) {
  return JSON.parse(readFileSync(value.statePath, 'utf8'));
}

test('activation publication: un échec de curation laisse environnement et timers intacts', () => {
  const value = fixture();
  const result = runActivation(value, { CURATE_FAIL: '1' });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(value.configDir, 'publication.env'), 'utf8'), value.oldPublicationEnv);
  assert.deepEqual(timerState(value), value.initialState);
  assert.equal(readFileSync(value.observedPath, 'utf8'), value.oldPublicationEnv);
});

test('activation publication: un échec du publisher restaure chaque état timer initial', () => {
  const value = fixture();
  const result = runActivation(value, { SYSTEMCTL_FAIL_ENABLE_NOW: '1' });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(value.configDir, 'publication.env'), 'utf8'), value.oldPublicationEnv);
  assert.deepEqual(timerState(value), value.initialState);
});

test('activation publication: la postcondition détecte un faux succès et déclenche le rollback', () => {
  const value = fixture();
  value.initialState[publisherTimer] = { enabled: false, active: false };
  writeFileSync(value.statePath, `${JSON.stringify(value.initialState, null, 2)}\n`);
  const result = runActivation(value, { SYSTEMCTL_NOOP_ENABLE_NOW: '1' });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(value.configDir, 'publication.env'), 'utf8'), value.oldPublicationEnv);
  assert.deepEqual(timerState(value), value.initialState);
  assert.match(result.stderr, /Postcondition timers invalide/);
});

test('activation publication: succès seulement avec publisher actif et legacy entièrement arrêté', () => {
  const value = fixture();
  const result = runActivation(value);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(value.observedPath, 'utf8'), value.oldPublicationEnv);
  const publicationEnv = readFileSync(join(value.configDir, 'publication.env'), 'utf8');
  assert.match(publicationEnv, /MEDIA_ENGINE_PUBLICATION_DAILY_LIMIT=10/);
  assert.match(publicationEnv, /MEDIA_ENGINE_PUBLICATION_EXTRA_NEWS_DAILY_LIMIT=2/);
  assert.deepEqual(timerState(value)[publisherTimer], { enabled: true, active: true });
  for (const unit of legacyTimers) {
    assert.deepEqual(timerState(value)[unit], { enabled: false, active: false });
  }
});
