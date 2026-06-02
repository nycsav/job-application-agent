#!/usr/bin/env node
/**
 * Scanner Agent — Daily Job Discovery
 *
 * WHAT IT DOES:
 * 1. Searches target company career pages for new roles
 * 2. Scans LinkedIn/Indeed job alert emails via Gmail MCP
 * 3. Scores each role against candidate profile (0-10)
 * 4. Filters: only score 5+ goes to Google Sheet (reduces noise)
 * 5. Score 7+ → High Profile tab. Score 8+ → auto-generate materials
 * 6. Speed matters: high-score roles should reach "ready to submit" ASAP
 *
 * DESIGNED FOR: Claude Code Routine (runs every 4 hours weekdays)
 */

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const MINIMUM_SHEET_SCORE = 5;
const HIGH_PROFILE_SCORE = 7;
const AUTO_MATERIALS_SCORE = 8;
const EXCLUDE_COMPANIES = ['Perplexity', 'BOI', 'Board of Innovation'];

const EMAIL_SOURCE = {
  enabled: true,
  gmail_queries: [
    // Group A: Job alert digests from ANY platform (platform-agnostic)
    'from:(indeed.com OR linkedin.com OR glassdoor.com OR dice.com OR ziprecruiter.com OR ladders.com OR hired.com OR wellfound.com OR otta.com OR jackandjill.ai OR getro.com) newer_than:8h -label:JobAgent/Processed',
    'subject:(job alert OR new jobs OR jobs for you OR job recommendation OR role match OR career opportunity) newer_than:8h -label:JobAgent/Processed',
    // Group B: Title-based searches (catches any source)
    'subject:(VP AI OR Director AI OR Head of AI OR Chief AI Officer OR AI transformation OR enterprise AI strategy) newer_than:8h -label:JobAgent/Processed',
    'subject:(Solutions Architect OR AI Architect OR Principal AI OR Applied AI OR agentic OR Claude OR LLM) newer_than:8h -label:JobAgent/Processed',
    'subject:(Partner Director OR Alliance Manager OR Strategic Partnerships OR BD AI OR ecosystem) newer_than:8h -label:JobAgent/Processed',
    'subject:(AI Strategy OR AI Advisory OR AI Consulting OR Management Consulting AI OR Digital Strategy) newer_than:8h -label:JobAgent/Processed',
    // Group C: Recruiter outreach from any sender
    'from:(recruiter OR talent OR hiring OR staffing OR headhunter OR search) subject:(AI OR opportunity OR role OR position OR candidate) newer_than:8h -label:JobAgent/Processed',
    'subject:(reaching out OR exciting opportunity OR perfect fit OR open role) (AI OR strategy OR director OR VP) newer_than:8h -label:JobAgent/Processed',
    'to:sav.banerjee@gmail.com newer_than:8h -from:linkedin.com -from:indeed.com -from:glassdoor.com -category:promotions -category:social -label:JobAgent/Processed',
    // Group D: Newsletter hiring sections
    'from:(substack.com OR beehiiv.com OR every.to OR a16z.com) subject:(hiring OR open roles OR founding team) newer_than:8h -label:JobAgent/Processed',
  ],
  processed_label: 'JobAgent/Processed',
  extract_fields: ['title', 'company', 'location', 'apply_url', 'description_snippet'],
};

const TARGET_COMPANIES = [
  { name: 'Anthropic', careers_url: 'https://boards.greenhouse.io/anthropic', platform: 'greenhouse', keywords: ['solutions architect', 'applied ai', 'enterprise', 'partnerships', 'strategy'], min_score: 7 },
  { name: 'OpenAI', careers_url: 'https://openai.com/careers/search', platform: 'ashby', keywords: ['partnerships', 'solutions', 'applied ai', 'enterprise'], min_score: 7 },
  { name: 'Google DeepMind', careers_url: 'https://www.google.com/about/careers/applications/jobs/results?q=deepmind', platform: 'google_careers', keywords: ['product manager', 'strategy', 'agentic', 'partnerships'], min_score: 7 },
  { name: 'Cuesta Partners', careers_url: 'https://www.cuestapartners.com/careers', platform: 'lever', keywords: ['ai', 'transformation', 'consulting'], min_score: 6 },
  { name: 'McKinsey', careers_url: 'https://www.mckinsey.com/careers/search-jobs', platform: 'custom', keywords: ['ai', 'digital', 'transformation'], min_score: 7 },
  { name: 'BCG', careers_url: 'https://careers.bcg.com/search-jobs', platform: 'custom', keywords: ['ai', 'digital'], min_score: 7 },
  { name: 'Bain', careers_url: 'https://www.bain.com/careers/', platform: 'custom', keywords: ['ai', 'advanced analytics'], min_score: 7 },
  { name: 'Goldman Sachs', careers_url: 'https://higher.gs.com/roles', platform: 'custom', keywords: ['ai', 'machine learning', 'strategy'], min_score: 7 }
];

const SCORING_CRITERIA = {
  title_match: { weight: 3, signals: { strong: ['Director', 'VP', 'Head of', 'Principal'], moderate: ['Senior Manager', 'Manager', 'Lead'], weak: ['Associate', 'Junior']} },
  skill_overlap: { weight: 3, candidate_skills: ['AI strategy', 'agentic systems', 'Claude', 'MCP', 'LLM', 'enterprise consulting', 'Fortune 500', 'pilot to production', 'RAG', 'multi-agent'] },
  industry_fit: { weight: 2, strong_industries: ['AI/ML', 'technology', 'consulting'], moderate_industries: ['media', 'financial services'] },
  location_match: { weight: 1, preferred: ['New York', 'Remote', 'Hybrid'] },
  compensation_signal: { weight: 1 }
};

export function scoreRole(role) {
  let total = 0;
  let maxPossible = 0;
  const breakdown = {};

  const titleUpper = (role.title || '').toUpperCase();
  if (SCORING_CRITERIA.title_match.signals.strong.some(s => titleUpper.includes(s.toUpperCase()))) { breakdown.title = 3; }
  else if (SCORING_CRITERIA.title_match.signals.moderate.some(s => titleUpper.includes(s.toUpperCase()))) { breakdown.title = 2; }
  else { breakdown.title = 1; }
  total += breakdown.title; maxPossible += 3;

  const descLower = ((role.description || '') + ' ' + (role.requirements || '')).toLowerCase();
  const matchedSkills = SCORING_CRITERIA.skill_overlap.candidate_skills.filter(s => descLower.includes(s.toLowerCase()));
  // Tiered skill scoring: 4+ matches = 3, 2-3 = 2, 1 = 1, 0 = 0
  // (JDs rarely mention all 10 skills, so 4+ is a strong signal)
  if (matchedSkills.length >= 4) { breakdown.skills = 3; }
  else if (matchedSkills.length >= 2) { breakdown.skills = 2; }
  else if (matchedSkills.length >= 1) { breakdown.skills = 1; }
  else { breakdown.skills = 0; }
  breakdown.matched_skills = matchedSkills;
  total += breakdown.skills; maxPossible += 3;

  const companyLower = (role.company || '').toLowerCase();
  if (SCORING_CRITERIA.industry_fit.strong_industries.some(i => descLower.includes(i.toLowerCase()) || companyLower.includes(i.toLowerCase()))) { breakdown.industry = 2; }
  else if (SCORING_CRITERIA.industry_fit.moderate_industries.some(i => descLower.includes(i.toLowerCase()))) { breakdown.industry = 1; }
  else { breakdown.industry = 0; }
  total += breakdown.industry; maxPossible += 2;

  const locLower = (role.location || '').toLowerCase();
  breakdown.location = SCORING_CRITERIA.location_match.preferred.some(l => locLower.includes(l.toLowerCase())) ? 1 : 0;
  total += breakdown.location; maxPossible += 1;

  breakdown.compensation = breakdown.title >= 2 ? 1 : 0;
  total += breakdown.compensation; maxPossible += 1;

  const score = Math.round((total / maxPossible) * 10);
  return { score, breakdown, matchedSkills };
}

// ── Qualification gate (added 2026-05-29) ───────────────────────────────
// scoreRole() rates on title/skills/industry/location/comp but has NO check
// for hard disqualifiers. Sav has a B.A. Advertising (no CS/eng degree) and is
// an AI strategy/transformation/architect-ADVISORY leader, not a classical SWE.
// This gate MUST pass before any auto-submit. Pull the LIVE JD first — title
// alone hides the degree requirement (see AlixPartners/AHT, 2026-05-29).
export function requiresCSDegree(jd = '') {
  return /(bachelor'?s?|b\.?s\.?|master'?s?|degree)[^.]{0,40}\b(computer science|cs|engineering)\b[^.]{0,30}\b(required|require|must)\b/i.test(jd)
      || /\b(cs|computer science|engineering)\s+degree\s+(is\s+)?(required|mandatory)/i.test(jd);
}
export function isHandsOnICEngineer(role = {}) {
  const title = role.title || '';
  const hasLeadershipPrefix = /(VP|Vice President|Head of|Director|Chief|Senior Director)/i.test(title);
  const engineerTitle = /\b(engineer|developer|swe)\b/i.test(title);
  const jd = ((role.description || '') + ' ' + (role.requirements || ''));
  const dailyCoding = /(write production code|writes production code|hands-on coding|ship production|production applications|terraform|microservices|kubernetes|docker|\bpython\b|\btypescript\b|\bgolang\b)/i.test(jd);
  return engineerTitle && !hasLeadershipPrefix && dailyCoding;
}
// Returns { pass, reasons[] }. pass=false ⇒ do NOT auto-submit; log + skip.
export function roleQualificationGate(role = {}) {
  const jd = ((role.description || '') + ' ' + (role.requirements || ''));
  const reasons = [];
  if (requiresCSDegree(jd)) reasons.push('CS/engineering degree required (Sav has none)');
  if (isHandsOnICEngineer(role)) reasons.push('hands-on IC engineer role (Sav is advisory/leadership, not a classical SWE)');
  return { pass: reasons.length === 0, reasons };
}

export { TARGET_COMPANIES, SCORING_CRITERIA, EMAIL_SOURCE, EMAIL_SOURCE as LINKEDIN_EMAIL_SOURCE, MINIMUM_SHEET_SCORE, HIGH_PROFILE_SCORE, AUTO_MATERIALS_SCORE, EXCLUDE_COMPANIES };