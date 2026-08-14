import assert from 'node:assert/strict';
import test from 'node:test';

import {
  candidateRequiresOfficialEvidence,
  DEFAULT_MAX_CANDIDATE_AGE_HOURS,
  matchOffer,
  qualifyCandidate,
  textMatchesKeyword,
} from '../media/candidates.mjs';
import { mediaBySlug } from '../media/registry.mjs';

const NOW = new Date('2026-08-14T12:00:00.000Z');

function media({
  slug = 'logiciels',
  risk = 'standard',
  topicKeywords = ['Tesla'],
} = {}) {
  return { slug, risk, topicKeywords };
}

function secondaryCandidate({
  title = 'Tesla publie une nouvelle fonctionnalité',
  publishedAt = '2026-08-14T08:00:00.000Z',
  sourceExcerpt = 'Une analyse thématique et factuelle.',
} = {}) {
  return {
    id: 'candidate-1',
    title,
    primaryUrl: 'https://media-a.example/article',
    publishedAt,
    sources: [
      {
        sourceId: 'media-a', tier: 2, official: false, title,
        excerpt: sourceExcerpt, url: 'https://media-a.example/article', publishedAt,
      },
      {
        sourceId: 'media-b', tier: 2, official: false, title,
        excerpt: sourceExcerpt, url: 'https://media-b.example/article', publishedAt,
      },
    ],
  };
}

test('matching thématique: les mots courts et les phrases respectent les bornes de tokens', () => {
  assert.equal(textMatchesKeyword('India improves software reliability', 'IA'), false);
  assert.equal(textMatchesKeyword('Le marché European progresse', 'PEA'), false);
  assert.equal(textMatchesKeyword("L'IA améliore la fiabilité", 'IA'), true);
  assert.equal(textMatchesKeyword('Le PEA progresse en Europe', 'PEA'), true);
  assert.equal(textMatchesKeyword('Tesla présente le Model Y restylé', 'Model Y'), true);
  assert.equal(textMatchesKeyword('Tesla présente le Model 3', 'Model Y'), false);

  const falsePositive = qualifyCandidate(
    secondaryCandidate({ title: 'India improves European software reliability' }),
    media({ topicKeywords: ['IA', 'PEA'] }),
    { now: NOW },
  );
  assert.deepEqual(falsePositive.keywordMatches, []);
  assert.ok(falsePositive.blockers.includes('hors-thématique'));

  const exact = qualifyCandidate(
    secondaryCandidate({ title: "L'IA aide les investisseurs à comprendre le PEA" }),
    media({ topicKeywords: ['IA', 'PEA'] }),
    { now: NOW },
  );
  assert.deepEqual(exact.keywordMatches, ['IA', 'PEA']);
});

test('matching offre: la même règle bornée évite IA dans India et PEA dans European', () => {
  const offers = [
    { id: 'ai', name: 'Offre IA', status: 'active', channels: ['logiciels'], url: 'https://offers.example/ai', keywords: ['IA'] },
    { id: 'pea', name: 'Offre PEA', status: 'active', channels: ['logiciels'], url: 'https://offers.example/pea', keywords: ['PEA'] },
  ];

  assert.equal(matchOffer(secondaryCandidate({ title: 'India improves European reliability' }), offers, 'logiciels'), null);
  assert.equal(matchOffer(secondaryCandidate({ title: "L'IA arrive en France" }), offers, 'logiciels')?.id, 'ai');
  assert.equal(matchOffer(secondaryCandidate({ title: 'Le PEA finance les actions européennes' }), offers, 'logiciels')?.id, 'pea');
});

test('fraîcheur: 72 h par défaut, blocker explicite et maximum configurable', () => {
  assert.equal(DEFAULT_MAX_CANDIDATE_AGE_HOURS, 72);
  const exactlyAtLimit = secondaryCandidate({ publishedAt: '2026-08-11T12:00:00.000Z' });
  exactlyAtLimit.sources[0].official = true;
  exactlyAtLimit.sources[0].tier = 1;
  const atLimit = qualifyCandidate(exactlyAtLimit, media(), { now: NOW });
  assert.equal(atLimit.ageHours, 72);
  assert.equal(atLimit.maxAgeHours, 72);
  assert.equal(atLimit.status, 'qualified');
  assert.ok(!atLimit.blockers.includes('candidat-trop-ancien'));

  const tooOld = secondaryCandidate({ publishedAt: '2026-08-11T11:00:00.000Z' });
  tooOld.sources[0].official = true;
  tooOld.sources[0].tier = 1;
  const rejected = qualifyCandidate(tooOld, media(), { now: NOW });
  assert.equal(rejected.ageHours, 73);
  assert.equal(rejected.status, 'rejected');
  assert.ok(rejected.blockers.includes('candidat-trop-ancien'));

  const acceptedWithOverride = qualifyCandidate(tooOld, media(), { now: NOW, maxAgeHours: 96 });
  assert.equal(acceptedWithOverride.maxAgeHours, 96);
  assert.equal(acceptedWithOverride.status, 'qualified');
  assert.ok(!acceptedWithOverride.blockers.includes('candidat-trop-ancien'));
});

test('preuve officielle: finance et fiscalité la requièrent toujours', () => {
  const candidate = secondaryCandidate();
  assert.equal(candidateRequiresOfficialEvidence(candidate, media({ risk: 'standard' })), false);
  assert.equal(candidateRequiresOfficialEvidence(candidate, media({ risk: 'commercial' })), false);
  for (const risk of ['regulated-finance', 'legal-tax']) {
    const targetMedia = media({ risk });
    assert.equal(candidateRequiresOfficialEvidence(candidate, targetMedia), true);
    const result = qualifyCandidate(candidate, targetMedia, { now: NOW });
    assert.equal(result.officialRequired, true);
    assert.equal(result.corroborated, false);
    assert.ok(result.blockers.includes('source-officielle-requise'));
  }
});

test('preuve officielle: une actualité Tesla produit ordinaire accepte deux sources indépendantes', () => {
  const targetMedia = media({ slug: 'tesla-tech', risk: 'product-safety', topicKeywords: ['Tesla'] });
  const candidate = secondaryCandidate({ title: 'Tesla lance une nouvelle couleur pour le Model Y' });
  const result = qualifyCandidate(candidate, targetMedia, { now: NOW });

  assert.equal(candidateRequiresOfficialEvidence(candidate, targetMedia), false);
  assert.equal(result.officialRequired, false);
  assert.equal(result.independentSourceCount, 2);
  assert.equal(result.corroborated, true);
  assert.equal(result.status, 'qualified');
  assert.ok(!result.blockers.includes('source-officielle-requise'));
});

test('preuve officielle: sécurité, rappel ou accident Tesla activent le gate officiel', () => {
  const targetMedia = media({ slug: 'tesla-tech', risk: 'product-safety', topicKeywords: ['Tesla'] });
  for (const subject of [
    'Tesla annonce un rappel du Model Y',
    'Tesla publie une alerte de sécurité',
    'Tesla analyse un accident du Model 3',
    'Tesla Model Y battery fire triggers an investigation',
    'NHTSA probes a Tesla suspension failure',
  ]) {
    const candidate = secondaryCandidate({ title: subject });
    const result = qualifyCandidate(candidate, targetMedia, { now: NOW });
    assert.equal(candidateRequiresOfficialEvidence(candidate, targetMedia), true, subject);
    assert.equal(result.officialRequired, true, subject);
    assert.equal(result.status, 'rejected', subject);
    assert.ok(result.blockers.includes('source-officielle-requise'), subject);
  }

  const mentionedOnlyInEvidence = secondaryCandidate({
    title: 'Tesla met à jour le Model Y',
    sourceExcerpt: 'Le média évoque un recall aux États-Unis.',
  });
  assert.equal(candidateRequiresOfficialEvidence(mentionedOnlyInEvidence, targetMedia), true);

  const official = secondaryCandidate({ title: 'Tesla annonce un rappel du Model Y' });
  official.sources[0].official = true;
  official.sources[0].tier = 1;
  const corroborated = qualifyCandidate(official, targetMedia, { now: NOW });
  assert.equal(corroborated.officialRequired, true);
  assert.equal(corroborated.corroborated, true);
  assert.equal(corroborated.status, 'qualified');
});

test('scoring: deux sources secondaires indépendantes, fraîches et thématiques atteignent 70', () => {
  const result = qualifyCandidate(secondaryCandidate(), media(), { now: NOW });

  assert.equal(result.officialRequired, false);
  assert.equal(result.officialSourceCount, 0);
  assert.equal(result.independentSourceCount, 2);
  assert.deepEqual(result.keywordMatches, ['Tesla']);
  assert.equal(result.offer, null);
  assert.equal(result.score, 70);
  assert.equal(result.status, 'qualified');
});

test('taxonomie: GPT et les paiements BCE sont reconnus sans sous-chaîne ambiguë', () => {
  const official = (title, url) => ({
    id: url,
    title,
    primaryUrl: url,
    publishedAt: '2026-08-14T08:00:00.000Z',
    sources: [{ sourceId: 'official', tier: 0, official: true, title, url, excerpt: title, publishedAt: '2026-08-14T08:00:00.000Z' }],
  });
  const software = qualifyCandidate(
    official('Previewing Ultrafast mode: GPT-5.6 Sol at up to 14X the speed', 'https://openai.com/index/gpt-5-6-sol'),
    mediaBySlug('logiciels'),
    { now: NOW },
  );
  assert.equal(software.status, 'qualified');
  assert.ok(software.keywordMatches.includes('GPT'));

  const hub = qualifyCandidate(
    official('OpenAI annonce GPT pour les créateurs et entrepreneurs', 'https://openai.com/index/gpt-creators'),
    mediaBySlug('chaimbault'),
    { now: NOW },
  );
  assert.equal(hub.status, 'qualified');
  assert.ok(hub.keywordMatches.includes('OpenAI'));
  assert.ok(hub.keywordMatches.includes('GPT'));

  const finance = qualifyCandidate(
    official('Cash remains the most widely accepted payment method in the euro area', 'https://ecb.europa.eu/press/cash'),
    mediaBySlug('investissement'),
    { now: NOW },
  );
  assert.equal(finance.status, 'qualified');
  assert.ok(finance.keywordMatches.includes('cash'));
  assert.equal(finance.officialRequired, true);
});
