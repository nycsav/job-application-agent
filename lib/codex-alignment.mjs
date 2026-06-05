import alignmentConfig from '../config/codex-alignment-model.json' with { type: 'json' };
import { classifyRoleArchetypes } from './codex-archetypes.mjs';

export function evaluateRoleAlignment(role, { config = alignmentConfig } = {}) {
  const classification = classifyRoleArchetypes(role);
  const best = classification.best;
  const text = lower(`${role.title || ''} ${role.company || ''} ${role.description || ''} ${role.requirements || ''}`);

  const candidateHits = matchSignals(text, config.candidateEvidenceSignals || []);
  const marketSignals = best ? config.marketSignalsByArchetype?.[best.id] || [] : [];
  const marketHits = matchSignals(text, marketSignals);

  const candidateCorpusFit = boundedScore(candidateHits.length, 8);
  const marketCategoryFit = boundedScore(marketHits.length, 5);
  const jdArchetypeFit = classification.strategicFit || 0;

  const alignmentScore = Math.round(
    candidateCorpusFit * 0.35 +
    marketCategoryFit * 0.35 +
    jdArchetypeFit * 0.3
  );

  const flags = buildFlags({
    role,
    text,
    candidateCorpusFit,
    marketCategoryFit,
    jdArchetypeFit,
    best,
    candidateHits,
    marketHits
  });

  return {
    score: alignmentScore,
    band: alignmentBand(alignmentScore, config.alignmentBands),
    candidateCorpusFit,
    marketCategoryFit,
    jdArchetypeFit,
    candidateHits,
    marketHits,
    archetype: best,
    flags,
    sources: sourceList(best?.id, config.marketSources || [])
  };
}

export function alignmentBand(score, bands = alignmentConfig.alignmentBands) {
  if (score >= (bands.strong || 8)) return 'strong';
  if (score >= (bands.good || 6)) return 'good';
  if (score >= (bands.weak || 4)) return 'weak';
  return 'poor';
}

function buildFlags({ text, candidateCorpusFit, marketCategoryFit, jdArchetypeFit, best, candidateHits, marketHits }) {
  const flags = [];
  if (!best || jdArchetypeFit < 4) flags.push('jd_does_not_match_approved_archetypes');
  if (candidateCorpusFit < 5) flags.push('weak_candidate_evidence_overlap');
  if (marketCategoryFit < 5) flags.push('weak_current_market_pattern_overlap');
  if (jdArchetypeFit >= 7 && candidateCorpusFit < 5) flags.push('archetype_match_but_resume_evidence_thin');
  if (candidateCorpusFit >= 7 && marketCategoryFit < 5) flags.push('sav_fit_but_market_language_weak');
  if (/backend engineer|frontend engineer|software engineer ii|software engineer iii/.test(text)) flags.push('likely_too_ic_engineering');
  if (/computer science degree required|requires computer science degree|engineering degree required/.test(text)) flags.push('possible_degree_gate');
  if (/brand strategy|advertising strategy/.test(text) && !/\b(ai|agentic|transformation)\b/.test(text)) flags.push('legacy_advertising_without_ai_pivot');
  if (!candidateHits.length && !marketHits.length) flags.push('no_alignment_evidence_found');
  return flags;
}

function sourceList(archetypeId, sources) {
  if (!archetypeId) return [];
  return sources.filter((source) => source.archetype === archetypeId);
}

function boundedScore(hitCount, targetCount) {
  if (!targetCount) return 0;
  return Math.max(0, Math.min(10, Math.round((hitCount / targetCount) * 10)));
}

function matchSignals(text, signals = []) {
  return signals.filter((signal) => text.includes(lower(signal)));
}

function lower(value = '') {
  return String(value || '').toLowerCase();
}
