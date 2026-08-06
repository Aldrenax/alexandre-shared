#!/usr/bin/env node

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import {
  NewsletterAttributionError,
  newsletterAllowedOrigins,
  newsletterHealth,
  normalizeNewsletterAttribution,
  recordNewsletterAttribution,
} from '../media/newsletter-attribution.mjs';
import { MediaStateStore } from '../media/state-store.mjs';

const MAX_BODY_BYTES = 16 * 1024;

function sendJson(response, status, payload, origin = null) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
  response.end(`${JSON.stringify(payload)}\n`);
}

async function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new NewsletterAttributionError('Corps trop volumineux', { code: 'payload_too_large', status: 413 });
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new NewsletterAttributionError('Corps JSON invalide', { code: 'invalid_json' });
  }
}

export function createNewsletterShadowHandler({
  store = new MediaStateStore(),
  secret = process.env.NEWSLETTER_ATTRIBUTION_HMAC_SECRET,
  allowedOrigins = newsletterAllowedOrigins(),
  now = () => new Date(),
} = {}) {
  const allowed = new Set(allowedOrigins);
  return async (request, response) => {
    const origin = request.headers.origin || null;
    const acceptedOrigin = origin && allowed.has(origin) ? origin : null;
    if (origin && !acceptedOrigin) {
      sendJson(response, 403, { error: 'origin_not_allowed' });
      return;
    }
    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      if (acceptedOrigin) response.setHeader('Access-Control-Allow-Origin', acceptedOrigin);
      response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      response.setHeader('Access-Control-Max-Age', '600');
      response.end();
      return;
    }
    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, 200, newsletterHealth(store));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/newsletter/attribution') {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }
    try {
      const payload = await readJsonBody(request);
      const event = normalizeNewsletterAttribution(payload, { secret, now: now() });
      const result = recordNewsletterAttribution(store, event);
      sendJson(response, 202, {
        accepted: true,
        eventId: event.eventId,
        mediaSlug: event.mediaSlug,
        duplicate: result.duplicate,
        syncStatus: event.syncStatus,
      }, acceptedOrigin);
    } catch (error) {
      const status = error instanceof NewsletterAttributionError ? error.status : 500;
      const code = error instanceof NewsletterAttributionError ? error.code : 'internal_error';
      sendJson(response, status, { accepted: false, error: code }, acceptedOrigin);
    }
  };
}

export function startNewsletterShadowServer({
  host = process.env.NEWSLETTER_SHADOW_HOST || '127.0.0.1',
  port = Number(process.env.NEWSLETTER_SHADOW_PORT || 8097),
  mode = process.env.NEWSLETTER_SHADOW_MODE,
  secret = process.env.NEWSLETTER_ATTRIBUTION_HMAC_SECRET,
  store = new MediaStateStore(),
} = {}) {
  if (mode !== 'shadow') throw new Error('NEWSLETTER_SHADOW_MODE=shadow requis');
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('NEWSLETTER_ATTRIBUTION_HMAC_SECRET invalide');
  store.initialize();
  const server = createServer(createNewsletterShadowHandler({ store, secret }));
  server.listen(port, host, () => {
    console.log(`[newsletter-shadow] actif sur http://${host}:${port} (aucune synchronisation Systeme.io)`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startNewsletterShadowServer();
