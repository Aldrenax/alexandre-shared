import { createHash, createHmac } from 'node:crypto';

import { activeMedia, mediaBySlug } from './registry.mjs';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IDEMPOTENCY_PATTERN = /^[a-zA-Z0-9._:-]{8,128}$/;
const UTM_KEYS = Object.freeze(['source', 'medium', 'campaign', 'content', 'term']);

export class NewsletterAttributionError extends Error {
  constructor(message, { code = 'invalid_payload', status = 400 } = {}) {
    super(message);
    this.name = 'NewsletterAttributionError';
    this.code = code;
    this.status = status;
  }
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ');
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function normalizedHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '');
}

function parseSafeUrl(value, field, { required = false } = {}) {
  const cleaned = cleanText(value, 2_048);
  if (!cleaned) {
    if (required) throw new NewsletterAttributionError(`${field} requis`, { code: `missing_${field}` });
    return null;
  }
  let parsed;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new NewsletterAttributionError(`${field} invalide`, { code: `invalid_${field}` });
  }
  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new NewsletterAttributionError(`${field} invalide`, { code: `invalid_${field}` });
  }
  return parsed;
}

function safeUrlSnapshot(url) {
  if (!url) return null;
  return {
    host: normalizedHost(url.hostname),
    path: cleanText(url.pathname, 512) || '/',
  };
}

function normalizeUtm(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return Object.fromEntries(
    UTM_KEYS
      .map((key) => [key, cleanText(source[key] ?? source[`utm_${key}`], 160)])
      .filter(([, value]) => value),
  );
}

export function newsletterAllowedOrigins(media = activeMedia()) {
  return media
    .map((item) => item.siteUrl)
    .filter(Boolean)
    .flatMap((siteUrl) => {
      const url = new URL(siteUrl);
      const origins = [url.origin];
      const host = normalizedHost(url.hostname);
      origins.push(`${url.protocol}//www.${host}${url.port ? `:${url.port}` : ''}`);
      return origins;
    });
}

export function normalizeNewsletterAttribution(payload, {
  secret,
  now = new Date(),
} = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new NewsletterAttributionError('Corps JSON invalide');
  }
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new NewsletterAttributionError('Secret HMAC indisponible', { code: 'server_not_configured', status: 503 });
  }

  const email = cleanText(payload.email, 320)?.toLowerCase();
  if (!email || !EMAIL_PATTERN.test(email)) {
    throw new NewsletterAttributionError('Email invalide', { code: 'invalid_email' });
  }
  if (payload.consent !== true) {
    throw new NewsletterAttributionError('Consentement explicite requis', { code: 'consent_required' });
  }

  const mediaSlug = cleanText(payload.mediaSlug, 80);
  const media = mediaBySlug(mediaSlug);
  if (!media || !media.editorialEnabled || !media.siteUrl) {
    throw new NewsletterAttributionError('Média inactif ou inconnu', { code: 'invalid_media' });
  }

  const formVersion = cleanText(payload.formVersion, 80);
  if (!formVersion) {
    throw new NewsletterAttributionError('Version du formulaire requise', { code: 'missing_form_version' });
  }
  const idempotencyKey = cleanText(payload.idempotencyKey, 128);
  if (!idempotencyKey || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    throw new NewsletterAttributionError('Clé d’idempotence invalide', { code: 'invalid_idempotency_key' });
  }

  const pageUrl = parseSafeUrl(payload.pageUrl, 'page_url', { required: true });
  const expectedHost = normalizedHost(new URL(media.siteUrl).hostname);
  if (normalizedHost(pageUrl.hostname) !== expectedHost) {
    throw new NewsletterAttributionError('Le site ne correspond pas au média', { code: 'origin_mismatch' });
  }
  const referrer = parseSafeUrl(payload.referrer, 'referrer');
  const subscriberKey = createHmac('sha256', secret).update(email).digest('hex');
  const eventId = `newsletter-${createHash('sha256').update(`${mediaSlug}:${idempotencyKey}`).digest('hex').slice(0, 32)}`;
  const observedAt = now.toISOString();

  return {
    version: 1,
    eventId,
    type: 'newsletter.signup.attributed',
    observedAt,
    consent: {
      granted: true,
      recordedAt: observedAt,
      formVersion,
    },
    subscriberKey,
    mediaSlug,
    site: safeUrlSnapshot(pageUrl),
    referrer: safeUrlSnapshot(referrer),
    utm: normalizeUtm(payload.utm),
    source: 'newsletter-form',
    syncStatus: 'shadow-only',
  };
}

export function recordNewsletterAttribution(store, event) {
  store.initialize();
  const before = store.read('newsletter-attribution', { version: 1, events: {} });
  const duplicate = Boolean(before.events?.[event.eventId]);
  const path = duplicate ? null : store.enqueue('newsletter-attribution', event.eventId, event);
  const summary = store.update('newsletter-attribution', (current) => {
    const previous = current.events?.[event.eventId];
    const media = { ...(current.media || {}) };
    if (!previous) {
      const mediaState = media[event.mediaSlug] || { accepted: 0 };
      media[event.mediaSlug] = {
        accepted: Number(mediaState.accepted || 0) + 1,
        lastAcceptedAt: event.observedAt,
      };
    }
    return {
      version: 1,
      mode: 'shadow',
      updatedAt: event.observedAt,
      accepted: Number(current.accepted || 0) + (previous ? 0 : 1),
      duplicates: Number(current.duplicates || 0) + (previous ? 1 : 0),
      media,
      events: {
        ...(current.events || {}),
        [event.eventId]: previous || {
          mediaSlug: event.mediaSlug,
          observedAt: event.observedAt,
          subscriberKey: event.subscriberKey,
        },
      },
    };
  }, { version: 1, mode: 'shadow', accepted: 0, duplicates: 0, media: {}, events: {} });
  return { path, duplicate, summary };
}

export function newsletterHealth(store) {
  const state = store.read('newsletter-attribution', {
    version: 1,
    mode: 'shadow',
    accepted: 0,
    duplicates: 0,
    media: {},
  });
  return {
    status: 'ok',
    mode: 'shadow',
    accepted: Number(state.accepted || 0),
    duplicates: Number(state.duplicates || 0),
    media: Object.fromEntries(Object.entries(state.media || {}).map(([slug, value]) => [slug, {
      accepted: Number(value.accepted || 0),
      lastAcceptedAt: value.lastAcceptedAt || null,
    }])),
    updatedAt: state.updatedAt || null,
  };
}
