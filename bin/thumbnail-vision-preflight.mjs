#!/usr/bin/env node

import { loadEnvironmentFile } from '../media/environment.mjs';
import { HermesClient } from '../media/hermes-client.mjs';
import { runThumbnailVisionPreflight } from '../media/thumbnail-vision-preflight.mjs';

loadEnvironmentFile(process.env.MEDIA_ENGINE_ENV_FILE || '/etc/alexandre-media-engine/media-engine.env');
loadEnvironmentFile(process.env.MEDIA_ENGINE_SHADOW_ENV_FILE || '/etc/alexandre-media-engine/shadow.env');

const result = await runThumbnailVisionPreflight({
  hermes: new HermesClient(),
});

console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
