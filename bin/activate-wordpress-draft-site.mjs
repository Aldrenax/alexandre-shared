#!/usr/bin/env node

import { activateWordPressDraftSite } from '../media/wordpress-draft-activation.mjs';

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const apply = process.argv.includes('--apply');
if (apply && typeof process.getuid === 'function' && process.getuid() !== 0) {
  process.stderr.write('L’activation doit être exécutée en root sur le VPS chaimbault.\n');
  process.exit(1);
}

try {
  const result = await activateWordPressDraftSite({
    envFile: argument('--env-file', '/etc/alexandre-media-engine/wordpress-shadow.env'),
    mediaSlug: argument('--media'),
    siteUrl: argument('--site-url'),
    expectedBlogId: Number(argument('--expected-blog-id', '0')),
    apply,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!apply) process.exitCode = 2;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
