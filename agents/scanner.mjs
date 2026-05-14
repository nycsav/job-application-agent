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

const LINKEDIN_EMAIL_SOURCE = {
  enabled: true,
  gmail_queries: [
    // Cluster 1: ai_transformation
    'subject:(VP AI OR Director AI OR Head of AI OR Chief AI Officer OR AI Program Director OR AI transformation OR enterprise AI strategy) newer_than:8h -label:JobAgent/Processed',
    'from:linkedin.com subject:(VP OR Director OR Head) subject:(AI OR artificial intelligence OR transformation) newer_than:8h -label:JobAgent/Processed',
    // Cluster 2: ai_architecture
    'subject:(Solutions Architect AI OR AI Architect OR Principal AI Engineer OR Applied AI OR Technical AI Lead OR agentic systems OR Claude OR LLM OR AI infrastructure) newer_than:8h -label:JobAgent/Processed',
    'from:linkedin.com subject:(architect OR engineer OR principal) subject:(AI OR ML OR LLM) newer_than:8h -label:JobAgent/Processed',
    // Cluster 3: ai_partnerships
    'subject:(Partner Director AI OR Alliance Manager OR BD AI OR Strategic Partnerships AI OR Partner Success OR ecosystem) newer_than:8h -label:JobAgent/Processed',
    // Cluster 4: ai_strategy_consulting
    'subject:(AI Strategy Consultant OR AI Advisory OR Strategy Director AI OR Management Consulting AI OR Digital Strategy OR AI consulting) newer_than:8h -label:JobAgent/Processed',
    // Catch-all: recruiter outreach + Indeed
    'from:(recruiter OR talent OR hiring) subject:(AI OR artificial intelligence OR opportunity) newer_than:8h -label:JobAgent/Processed',
    'from:indeed.com subject:(job OR alert OR recommendation) subject:(AI OR strategy OR director OR VP) newer_than:8h -label:JobAgent/Processed',
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
  breakdown.skills = Math.round((matchedSkills.length / SCORING_CRITERIA.skill_overlap.candidate_skills.length) * 3);
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

export { TARGET_COMPANIES, SCORING_CRITERIA, LINKEDIN_EMAIL_SOURCE, MINIMUM_SHEET_SCORE, HIGH_PROFILE_SCORE, AUTO_MATERIALS_SCORE, EXCLUDE_COMPANIES };