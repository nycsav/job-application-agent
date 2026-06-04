import archetypeConfig from '../config/codex-role-archetypes.json' with { type: 'json' };

const PRIORITY_MULTIPLIER = {
  highest: 1,
  high: 0.9,
  'medium-high': 0.8
};

export function classifyRoleArchetypes(role, { config = archetypeConfig } = {}) {
  const title = lower(role.title);
  const body = lower(`${role.title || ''} ${role.company || ''} ${role.description || ''} ${role.requirements || ''}`);
  const globalHits = matchSignals(body, config.globalPositiveSignals || []);
  const globalPenalties = matchSignals(body, config.globalPenaltySignals || []);

  const matches = (config.archetypes || []).map((archetype) => {
    const titleHits = matchSignals(title, archetype.titleSignals || []);
    const bodyHits = matchSignals(body, archetype.bodySignals || []);
    const priorityMultiplier = PRIORITY_MULTIPLIER[archetype.priority] || 0.7;

    const raw =
      titleHits.length * 3 +
      bodyHits.length * 1.4 +
      Math.min(globalHits.length, 6) * 0.45 -
      globalPenalties.length * 1.6;

    const score = Math.max(0, Math.min(10, Math.round(raw * priorityMultiplier)));
    return {
      id: archetype.id,
      label: archetype.label,
      priority: archetype.priority,
      resumeCluster: archetype.resumeCluster,
      secondaryResumeCluster: archetype.secondaryResumeCluster,
      bestResume: archetype.bestResume,
      score,
      titleHits,
      bodyHits,
      globalHits,
      penalties: globalPenalties
    };
  }).sort((a, b) => b.score - a.score);

  const best = matches[0] || null;
  return {
    best,
    matches,
    strategicFit: best?.score || 0,
    globalHits,
    penalties: globalPenalties
  };
}

export function strategicFitBand(score) {
  if (score >= 8) return 'highest-priority';
  if (score >= 6) return 'high-priority';
  if (score >= 4) return 'watchlist';
  return 'low-fit';
}

function matchSignals(text, signals = []) {
  return signals.filter((signal) => text.includes(lower(signal)));
}

function lower(value = '') {
  return String(value || '').toLowerCase();
}
