#!/usr/bin/env node
/**
 * Canned Answers Matcher — fills LinkedIn Easy Apply open-text questions
 * from candidate.json `easy_apply_answers` by matching question label keywords.
 *
 * Usage:
 *   import { matchAnswer, loadAnswers } from './canned-answers.mjs';
 *   const answers = await loadAnswers();
 *   const value = matchAnswer('How many years of software engineering experience do you have?', answers);
 *   // → "Not a classical SWE — 15+ years of technology product leadership..."
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CANDIDATE_PATH = join(__dirname, '..', 'config', 'candidate.json');

// Ordered keyword → answer-key mappings.
// Most specific patterns first so they win over generic catches.
// Each entry is [regex (case-insensitive), candidate.json key].
const KEYWORD_MAP = [
  // Identity / work eligibility
  [/sponsorship|h-?1b|visa\b/i, 'require_sponsorship'],
  [/authorized to work|work authorization|legally (eligible|authorized)/i, 'work_authorized_us'],
  [/citizen(ship)?\b/i, 'citizenship_status'],
  [/relocat/i, 'willing_to_relocate'],
  [/in.?person|on.?site|one of our offices|return to office|\brto\b|hybrid (work|schedule)/i, 'open_to_in_person_office'],
  [/business hours|schedule align|core hours|est\/edt|time ?zone|working hours/i, 'comfortable_est_hours'],
  [/current(ly)? (located|reside|live)|where (are|do) you (live|located)|current location|your location|what is your location/i, 'current_location'],
  [/how did you hear|hear about (us|this|the|our)|referral source|how.*found.*(us|role|position)/i, 'how_did_you_hear'],
  [/\bage\b|how old are you/i, 'current_age'],
  [/\bcountry\b|country of residence|what country/i, 'country'],

  // Compensation / availability
  [/notice period/i, 'notice_period'],
  [/start date|available to start|when can you (start|begin)/i, 'available_start_date'],
  [/(expected |desired |target )?(base )?salary|compensation expectation|expected pay/i, 'salary_expectation_total'],

  // Years of X — most specific first
  [/years?.*(software engineer|swe|engineering)/i, 'years_software_engineering'],
  [/years?.*(ai|machine learning|ml|llm|gen[\s-]?ai)/i, 'years_ai_ml_experience'],
  [/years?.*(consult|advisory)/i, 'years_consulting'],
  [/years?.*(people manage|managing (people|teams)|direct report|team lead)/i, 'years_people_management'],
  [/years?.*(leadership|lead role|leading)/i, 'years_leadership'],
  [/years?.*strateg/i, 'years_strategy'],
  [/years?.*(product manage|product management|pm)/i, 'years_product_management'],
  [/years?.*(enterprise sales|business development|bd\b)/i, 'years_enterprise_sales_bd'],
  [/(how many )?years?.*(experience|exp\b)/i, 'years_total_experience'],

  // Experience / domain knowledge — narrative answers
  [/client.?facing|agentic systems?|tell us about your experience/i, 'experience_with_ai_strategy'],
  [/senior leadership|executive (forum|presentation)|c-?suite|board.*present/i, 'senior_leadership_presentations'],
  [/global platform|platform ownership|own(ed|ing) (a )?(global )?platform/i, 'global_platform_ownership'],
  [/ai strategy/i, 'experience_with_ai_strategy'],
  [/transformation/i, 'experience_with_transformation'],
  [/fortune ?500|enterprise (client|customer)/i, 'experience_with_enterprise_clients'],
  [/pharma|healthcare|life ?sciences|fda|mlr/i, 'experience_with_pharma_healthcare'],
  [/financial services|banking|fintech|wealth/i, 'experience_with_financial_services'],
  [/claude|anthropic/i, 'experience_with_claude_anthropic'],

  // Education
  [/highest (level of |degree|education)|education level|degree/i, 'highest_education'],

  // EEO / demographics
  [/veteran/i, 'veteran_status'],
  [/disability|disabled/i, 'disability_status'],
  [/race|ethnicit/i, 'race_ethnicity'],
  [/gender\b/i, 'gender'],
];

let _cache = null;

export async function loadAnswers() {
  if (_cache) return _cache;
  const raw = await readFile(CANDIDATE_PATH, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!parsed.easy_apply_answers) {
    throw new Error('candidate.json missing easy_apply_answers section');
  }
  _cache = parsed.easy_apply_answers;
  return _cache;
}

/**
 * Match a question label to a canned-answer value.
 * Returns { key, value } if matched, or null if no match.
 *
 * @param {string} questionLabel - The text of the question label as scraped from the form.
 * @param {object} answers - Loaded easy_apply_answers object.
 */
export function matchAnswer(questionLabel, answers) {
  if (!questionLabel) return null;
  const label = questionLabel.trim();
  for (const [regex, key] of KEYWORD_MAP) {
    if (regex.test(label)) {
      if (answers[key] !== undefined) {
        return { key, value: answers[key], pattern: regex.source };
      }
    }
  }
  return null;
}

/**
 * Numeric-only answer for "how many" questions. If the canned value is a
 * narrative ("15+ years of..."), extract the leading number for fields that
 * require an integer.
 */
export function numericAnswer(value) {
  if (value === null || value === undefined) return null;
  const m = String(value).match(/(\d+)\+?/);
  return m ? Number(m[1]) : null;
}

/**
 * Yes/No answer mapping. Some forms have boolean radios — translate
 * "Yes"/"No"/"Not a..."/"Prefer not to answer" to the form's expected value.
 */
export function yesNoAnswer(value) {
  if (!value) return null;
  const s = String(value).toLowerCase();
  if (s.startsWith('yes')) return 'Yes';
  if (s.startsWith('no')) return 'No';
  if (s.includes('prefer not')) return 'Prefer not to answer';
  return null;
}

/**
 * CLI: `node daemon/canned-answers.mjs "How many years of AI experience?"`
 * Prints the matched answer (or null).
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const question = process.argv.slice(2).join(' ');
  if (!question) {
    console.error('Usage: node canned-answers.mjs "<question text>"');
    process.exit(1);
  }
  const answers = await loadAnswers();
  const match = matchAnswer(question, answers);
  console.log(JSON.stringify(match, null, 2));
}
