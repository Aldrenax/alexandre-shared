#!/usr/bin/env node

import { MediaStateStore } from '../media/state-store.mjs';

const [unit, result = 'unknown', exitCode = 'unknown', exitStatus = 'unknown'] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/i.test(unit || '')) {
  console.error('Usage: media-engine-unit-receipt.mjs <unit> <result> <exit-code> <exit-status>');
  process.exit(2);
}

const store = new MediaStateStore();
store.initialize();
store.write(`systemd-${unit}`, {
  version: 1,
  observedAt: new Date().toISOString(),
  unit,
  result,
  exitCode,
  exitStatus,
});
