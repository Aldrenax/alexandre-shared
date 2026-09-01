export const ARTICLE_THUMBNAIL_POLICY = 'youtube-thumbnail-imagegen:article-single-v3-qa';

export const ARTICLE_THUMBNAIL_PROFILES = Object.freeze({
  chaimbault: Object.freeze({
    colors: Object.freeze(['#1394C7']),
    palette: 'cyan #1394C7 dominant, with white and black reserved for contrast and typography',
    tone: 'credible, crisp, business-like and anti-hype',
  }),
  'tesla-tech': Object.freeze({
    colors: Object.freeze(['#B02112', '#E33A2E']),
    palette: 'signature red #B02112 dominant, rising toward #E33A2E; white and black only for contrast',
    tone: 'energetic, product and technology oriented, bright and not artificially dramatic',
  }),
  affiliation: Object.freeze({
    colors: Object.freeze(['#F4BD3D', '#FFDB70']),
    palette: 'signature yellow #F4BD3D dominant, rising toward #FFDB70; white and black only for contrast',
    tone: 'commercial, dynamic and bright, without income promises',
  }),
  logiciels: Object.freeze({
    colors: Object.freeze(['#65468A', '#8A6BB0']),
    palette: 'signature purple #65468A dominant, rising toward #8A6BB0; white, black and yellow only for contrast',
    tone: 'modern, practical, software-oriented and highly legible',
  }),
  investissement: Object.freeze({
    colors: Object.freeze(['#3E8C20', '#76B657']),
    palette: 'signature green #3E8C20 dominant, rising toward #76B657; white and black only for contrast',
    tone: 'reassuring, measured, factual and bright, without invented gains',
  }),
  entreprise: Object.freeze({
    colors: Object.freeze(['#1641A8', '#5E7DD0']),
    palette: 'signature blue #1641A8 dominant, rising toward #5E7DD0; white and black only for contrast',
    tone: 'serious, reassuring, bright and restrained',
  }),
});

export function articleThumbnailProfile(media) {
  return ARTICLE_THUMBNAIL_PROFILES[media?.slug] || ARTICLE_THUMBNAIL_PROFILES.chaimbault;
}

export function officialThumbnailAssets(draft) {
  return (draft?.bannerBrief?.officialAssets || [])
    .map((asset) => (typeof asset === 'string' ? { url: asset, kind: 'other' } : asset))
    .filter((asset) => /^https:\/\//u.test(String(asset?.url || '')))
    .map((asset) => ({
      url: String(asset.url),
      kind: ['logo', 'interface', 'face', 'other'].includes(asset.kind) ? asset.kind : 'other',
      label: String(asset.label || '').trim() || null,
    }));
}
