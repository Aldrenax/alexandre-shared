import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createNewsletterShadowHandler } from '../bin/newsletter-shadow-server.mjs';
import {
  newsletterHealth,
  normalizeNewsletterAttribution,
  recordNewsletterAttribution,
} from '../media/newsletter-attribution.mjs';
import { activeMedia } from '../media/registry.mjs';
import { MediaStateStore } from '../media/state-store.mjs';

const SECRET = 'test-secret-that-is-longer-than-thirty-two-characters';
const NOW = new Date('2026-08-06T12:00:00.000Z');

function validPayload(mediaSlug = 'chaimbault') {
  const media = activeMedia().find((item) => item.slug === mediaSlug);
  return {
    email: 'Alexandre+Test@Example.com',
    consent: true,
    mediaSlug,
    pageUrl: `${media.siteUrl}/newsletter/?email=must-not-leak`,
    referrer: 'https://www.google.com/search?q=private',
    formVersion: 'central-v1',
    idempotencyKey: `signup-${mediaSlug}-0001`,
    utm: {
      utm_source: 'youtube',
      utm_medium: 'description',
      utm_campaign: 'network',
      ignored: 'not-persisted',
    },
  };
}

test('newsletter shadow: les six médias actifs sont attribués à leur site canonique', () => {
  for (const media of activeMedia()) {
    const event = normalizeNewsletterAttribution(validPayload(media.slug), { secret: SECRET, now: NOW });
    assert.equal(event.mediaSlug, media.slug);
    assert.equal(event.site.host, new URL(media.siteUrl).hostname);
    assert.equal(event.site.path, '/newsletter/');
    assert.equal(event.syncStatus, 'shadow-only');
    assert.equal(event.consent.recordedAt, NOW.toISOString());
  }
});

test('newsletter shadow: aucune adresse ni query string sensible n’est persistée', () => {
  const event = normalizeNewsletterAttribution(validPayload(), { secret: SECRET, now: NOW });
  const serialized = JSON.stringify(event);
  assert.doesNotMatch(serialized, /Alexandre\+Test@Example\.com|must-not-leak|private/i);
  assert.equal(event.subscriberKey.length, 64);
  assert.deepEqual(event.utm, { source: 'youtube', medium: 'description', campaign: 'network' });
});

test('newsletter shadow: consentement, média, site et idempotence sont obligatoires', () => {
  assert.throws(
    () => normalizeNewsletterAttribution({ ...validPayload(), consent: false }, { secret: SECRET, now: NOW }),
    (error) => error.code === 'consent_required',
  );
  assert.throws(
    () => normalizeNewsletterAttribution({ ...validPayload(), mediaSlug: 'daily' }, { secret: SECRET, now: NOW }),
    (error) => error.code === 'invalid_media',
  );
  assert.throws(
    () => normalizeNewsletterAttribution({ ...validPayload(), pageUrl: 'https://alexandre-tesla.fr/newsletter/' }, { secret: SECRET, now: NOW }),
    (error) => error.code === 'origin_mismatch',
  );
  assert.throws(
    () => normalizeNewsletterAttribution({ ...validPayload(), idempotencyKey: 'short' }, { secret: SECRET, now: NOW }),
    (error) => error.code === 'invalid_idempotency_key',
  );
});

test('newsletter shadow: la même clé est idempotente et ne crée qu’un événement', () => {
  const store = new MediaStateStore(mkdtempSync(join(tmpdir(), 'newsletter-shadow-')));
  const first = normalizeNewsletterAttribution(validPayload(), { secret: SECRET, now: NOW });
  const later = normalizeNewsletterAttribution(validPayload(), { secret: SECRET, now: new Date('2026-08-06T12:10:00Z') });
  assert.equal(first.eventId, later.eventId);
  assert.equal(recordNewsletterAttribution(store, first).duplicate, false);
  assert.equal(recordNewsletterAttribution(store, later).duplicate, true);
  const files = readdirSync(join(store.queueDir, 'newsletter-attribution'));
  assert.equal(files.length, 1);
  const persisted = readFileSync(join(store.queueDir, 'newsletter-attribution', files[0]), 'utf8');
  assert.match(persisted, /2026-08-06T12:00:00/);
  assert.doesNotMatch(persisted, /Alexandre\+Test@Example\.com/i);
  assert.deepEqual(newsletterHealth(store), {
    status: 'ok',
    mode: 'shadow',
    accepted: 1,
    duplicates: 1,
    media: { chaimbault: { accepted: 1, lastAcceptedAt: NOW.toISOString() } },
    updatedAt: '2026-08-06T12:10:00.000Z',
  });
});

test('newsletter shadow HTTP: origine inconnue refusée et réponse sans donnée personnelle', async () => {
  const store = new MediaStateStore(mkdtempSync(join(tmpdir(), 'newsletter-http-')));
  const handler = createNewsletterShadowHandler({ store, secret: SECRET, now: () => NOW });

  function invoke({ method = 'GET', url = '/health', origin = null, body = null } = {}) {
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
    const request = {
      method,
      url,
      headers: origin ? { origin } : {},
      async *[Symbol.asyncIterator]() { yield* chunks; },
    };
    const headers = {};
    let responseBody = '';
    const response = {
      statusCode: 200,
      setHeader(key, value) { headers[key.toLowerCase()] = value; },
      end(value = '') { responseBody += value; },
    };
    return Promise.resolve(handler(request, response)).then(() => ({ status: response.statusCode, headers, body: responseBody }));
  }

  const refused = await invoke({ method: 'POST', url: '/v1/newsletter/attribution', origin: 'https://evil.example', body: validPayload() });
  assert.equal(refused.status, 403);
  assert.equal(JSON.parse(refused.body).error, 'origin_not_allowed');

  const accepted = await invoke({
    method: 'POST',
    url: '/v1/newsletter/attribution',
    origin: 'https://alexandrechaimbault.com',
    body: validPayload(),
  });
  assert.equal(accepted.status, 202);
  assert.equal(JSON.parse(accepted.body).syncStatus, 'shadow-only');
  assert.doesNotMatch(accepted.body, /Alexandre\+Test@Example\.com/i);
  assert.equal(accepted.headers['access-control-allow-origin'], 'https://alexandrechaimbault.com');
});
