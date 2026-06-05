import strategy from '../config/enso-market-strategy.json' with { type: 'json' };
import { evaluateRoleAlignment } from './codex-alignment.mjs';
import { parseSalaryCeiling } from './codex-filters.mjs';

export function classifyMarketOpportunity(opportunity, { config = strategy } = {}) {
  const text = lower(`${opportunity.title || ''} ${opportunity.company || ''} ${opportunity.description || ''} ${opportunity.salary || ''} ${opportunity.compensation || ''} ${opportunity.url || ''} ${opportunity.source || ''}`);
  const alignment = evaluateRoleAlignment(opportunity);
  const type = inferOpportunityType(text);
  const economics = economicsFor(opportunity, type, config);
  const segment = inferSegment(text, config.targetSegments || []);
  const searchTrack = type === 'w2' ? 'selective_w2' : type === 'contract' ? 'contract_project' : 'client_acquisition';
  const score = scoreOpportunity({ alignment, economics, type, segment });

  return {
    type,
    searchTrack,
    score,
    segment: segment?.segment || 'General enterprise AI',
    pitch: segment?.pitch || config.positioning,
    economics,
    alignment,
    recommendedAction: recommendedAction({ type, score, economics, alignment })
  };
}

export function buildMarketSearchQueries({ config = strategy } = {}) {
  return {
    w2: config.searchQueries?.w2 || [],
    contract: config.searchQueries?.contract || [],
    clientProspecting: config.searchQueries?.clientProspecting || []
  };
}

function inferOpportunityType(text) {
  if (/salary|\$[0-9]|full[- ]time|base salary|equity|employee|w2/.test(text)) return 'w2';
  if (/contract|fractional|consultant|consulting|freelance|retainer|managed services|implementation partner/.test(text)) return 'contract';
  if (/partner|agency|studio|services|consultancy|consulting firm|managed ai|claude implementation/.test(text)) return 'partner_prospect';
  if (/client|prospect|media agency|pharma agency|marketing organization/.test(text)) return 'client_prospect';
  return 'w2';
}

function economicsFor(opportunity, type, config) {
  const salaryCeiling = parseSalaryCeiling(opportunity.salary || opportunity.compensation || '');
  if (type === 'w2') {
    return {
      salaryCeiling,
      floor: config.w2Targets.baseSalaryFloor,
      preferred: config.w2Targets.preferredBaseSalary,
      premium: config.w2Targets.premiumBaseSalary,
      pass: salaryCeiling ? salaryCeiling >= config.w2Targets.baseSalaryFloor : true
    };
  }

  return {
    hourlyFloor: config.contractTargets.hourlyFloor,
    preferredHourly: config.contractTargets.preferredHourly,
    premiumHourly: config.contractTargets.premiumHourly,
    diagnosticRange: config.contractTargets.diagnosticRange,
    pilotToProductionRange: config.contractTargets.pilotToProductionRange,
    managedServicesRetainerRange: config.contractTargets.managedServicesRetainerRange,
    fractionalLeadRange: config.contractTargets.fractionalLeadRange,
    pass: true
  };
}

function inferSegment(text, segments) {
  const rules = [
    [/media|marketing|advertising|content|creative|agency|customer experience|cx/, 'Media and marketing organizations'],
    [/healthcare|pharma|medical|mlr|payer|provider|clinical/, 'Healthcare and pharma agencies'],
    [/finance|financial|fintech|trading|banking|insurance|portfolio/, 'Financial services and fintech'],
    [/platform|ai-native|agent platform|developer|saas|product/, 'AI-native platforms'],
    [/consulting|partner|implementation|services|studio|boutique/, 'Enterprise consulting and boutique partners']
  ];
  const match = rules.find(([regex]) => regex.test(text));
  return segments.find((segment) => segment.segment === match?.[1]) || segments[0];
}

function scoreOpportunity({ alignment, economics, type, segment }) {
  let score = alignment.score;
  if (type !== 'w2') score += 1;
  if (economics.pass === false) score -= 3;
  if (segment?.segment === 'Media and marketing organizations') score += 1;
  if (segment?.segment === 'Healthcare and pharma agencies') score += 1;
  return Math.max(0, Math.min(10, score));
}

function recommendedAction({ type, score, economics, alignment }) {
  if (economics.pass === false) return 'skip_or_negotiate_comp';
  if (score >= 8 && type === 'w2') return 'apply_with_matched_resume';
  if (score >= 8 && type === 'contract') return 'send_paid_diagnostic_pitch';
  if (score >= 7 && type === 'partner_prospect') return 'send_partner_capacity_pitch';
  if (score >= 6) return 'track_and_research';
  if (alignment.flags?.length) return `hold_due_to_${alignment.flags[0]}`;
  return 'low_priority';
}

function lower(value = '') {
  return String(value || '').toLowerCase();
}
