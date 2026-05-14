/**
 * UTM URL builder factorisé.
 *
 * `defaultSource` doit être fourni par le site (depuis CHANNEL.utmSource ou
 * SITE.utmSource). Si non fourni au moment de l'appel, le link reste sans
 * utm_source automatique.
 *
 * Usage scripts Node :
 *   import { addUtm } from 'alexandre-shared/lib/utm.mjs';
 *   import { CHANNEL } from '../../channel.config.mjs';
 *   addUtm(url, { source: CHANNEL.utmSource, campaign: 'mon-article' });
 *
 * Usage Astro (.astro/.ts) :
 *   import { addUtm } from 'alexandre-shared/lib/utm.mjs';
 *   import { SITE } from '../lib/site';
 *   addUtm(url, { source: SITE.utmSource, campaign: 'partner-x' });
 */

export function addUtm(rawUrl, opts = {}) {
  if (!rawUrl) return rawUrl;
  try {
    const u = new URL(rawUrl);
    const set = (k, v) => {
      if (!v) return;
      if (!u.searchParams.has(k)) u.searchParams.set(k, v);
    };
    set('utm_source', opts.source);
    set('utm_medium', opts.medium ?? 'article');
    set('utm_campaign', opts.campaign);
    set('utm_content', opts.content);
    return u.toString();
  } catch {
    return rawUrl;
  }
}

export function campaignFromSlug(slug) {
  return String(slug)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}
