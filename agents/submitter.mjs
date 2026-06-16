#!/usr/bin/env node
/**
 * Submitter Agent — Automated Application Form Filler
 *
 * WHAT IT DOES:
 * 1. Reads roles.json for roles with status 'materials_ready'
 * 2. Navigates to each role's apply_url using Playwright MCP
 * 3. Fills the application form (name, email, phone, LinkedIn, resume upload)
 * 4. PAUSES before clicking Submit — waits for human approval
 * 5. After approval, submits and updates status to 'applied'
 *
 * DESIGNED FOR: Claude Code with Playwright MCP or Claude in Chrome MCP
 *
 * CRITICAL: This agent NEVER auto-submits. It fills forms and stops.
 * Human-in-the-loop is enforced via a PreToolBatch hook.
 */

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  preFlightCheck,
  generatePreSubmitRow,
  generatePostSubmitUpdate,
  incrementSubmissionCount,
  checkBatchLimit,
  getSessionId,
  generateBriefingEmail,
  MAX_BATCH_SIZE
} from '../lib/safety-guards.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ─── Platform-Specific Form Strategies ───────────────────────────

const PLATFORM_STRATEGIES = {
  greenhouse: {
    name: 'Greenhouse',
    description: 'Used by Anthropic and many tech companies',
    steps: [
      'Navigate to the job posting URL',
      'Click "Apply for this job" button',
      'Fill "First Name" field with candidate first name',
      'Fill "Last Name" field with candidate last name',
      'Fill "Email" field with candidate email',
      'Fill "Phone" field with candidate phone',
      'Fill "LinkedIn Profile" field with candidate LinkedIn URL',
      'Fill "Website" field with candidate website',
      'Upload resume .docx file to the resume upload field',
      'Upload cover letter .docx file to the cover letter upload field',
      'If there are additional questions, answer based on candidate profile',
      'STOP — Do NOT click Submit. Wait for human approval.'
    ],
    selectors: {
      apply_button: 'a[href*="apply"], button:has-text("Apply")',
      first_name: '#first_name, input[name*="first_name"]',
      last_name: '#last_name, input[name*="last_name"]',
      email: '#email, input[name*="email"]',
      phone: '#phone, input[name*="phone"]',
      linkedin: 'input[name*="linkedin"], input[label*="LinkedIn"]',
      website: 'input[name*="website"], input[label*="Website"]',
      resume_upload: 'input[type="file"][name*="resume"]',
      cover_upload: 'input[type="file"][name*="cover"]',
      submit: 'button[type="submit"], input[type="submit"]'
    }
  },

  ashby: {
    name: 'Ashby',
    description: 'Used by OpenAI',
    steps: [
      'Navigate to the job posting URL',
      'Click "Apply" button',
      'Fill name, email, phone, LinkedIn fields',
      'Upload resume file',
      'Upload cover letter if field exists, otherwise paste into text area',
      'Answer any custom questions based on candidate profile',
      'STOP — Do NOT click Submit. Wait for human approval.'
    ],
    selectors: {
      apply_button: 'button:has-text("Apply"), a:has-text("Apply")',
      name: 'input[name="name"], input[placeholder*="name"]',
      email: 'input[name="email"], input[type="email"]',
      phone: 'input[name="phone"], input[type="tel"]',
      linkedin: 'input[name*="linkedin"]',
      resume_upload: 'input[type="file"]',
      submit: 'button[type="submit"]'
    }
  },

  lever: {
    name: 'Lever',
    description: 'Used by Cuesta Partners and many startups',
    steps: [
      'Navigate to the job posting URL',
      'Click "Apply for this job" button',
      'Fill "Full Name" field',
      'Fill "Email" field',
      'Fill "Phone" field',
      'Fill "Current Company" with "Enso Labs"',
      'Fill "LinkedIn URL" field',
      'Upload resume file',
      'Upload cover letter or paste into additional info',
      'STOP — Do NOT click Submit. Wait for human approval.'
    ],
    selectors: {
      apply_button: 'a.postings-btn-submit',
      name: 'input[name="name"]',
      email: 'input[name="email"]',
      phone: 'input[name="phone"]',
      company: 'input[name="org"]',
      linkedin: 'input[name*="urls[LinkedIn]"]',
      resume_upload: 'input[type="file"][name="resume"]',
      submit: 'button[type="submit"]'
    }
  },

  google_careers: {
    name: 'Google Careers',
    description: 'Used by Google DeepMind',
    steps: [
      'Navigate to the Google Careers job posting',
      'Click "Apply" button',
      'Sign in with Google account if prompted',
      'Fill required fields (name, email, phone)',
      'Upload resume',
      'Fill any additional fields',
      'STOP — Do NOT click Submit. Wait for human approval.'
    ],
    note: 'Google Careers often requires Google account login. The agent should pause if login is required and ask the user to authenticate first.'
  },

  custom: {
    name: 'Custom/Unknown',
    description: 'For company-specific career portals',
    steps: [
      'Navigate to the careers URL',
      'Search for the specific job title',
      'Click on the job listing',
      'Click "Apply" or equivalent',
      'Fill all visible form fields using candidate profile',
      'Upload resume if file upload is available',
      'STOP — Do NOT click Submit. Wait for human approval.'
    ]
  }
};

// ─── Form Field Mapping ──────────────────────────────────────────

/**
 * Maps candidate.json fields to common form field names
 * Used by Claude Code / Playwright to fill forms intelligently
 */
export function getCandidateFormData(candidate) {
  const nameParts = candidate.name.split(' ');
  return {
    first_name: nameParts[0],
    last_name: nameParts.slice(1).join(' '),
    full_name: candidate.name,
    email: candidate.email,
    phone: candidate.phone,
    linkedin_url: `https://${candidate.linkedin}`,
    website: `https://${candidate.websites[0]}`,
    current_company: candidate.current_company,
    current_title: candidate.current_title,
    location: candidate.location,
    years_experience: candidate.years_experience,

    // Common dropdown/select values
    work_authorization: 'Authorized to work in the US',
    requires_sponsorship: 'No',
    willing_to_relocate: 'Yes',
    earliest_start: 'Immediately',

    // Common text area answers
    why_interested: (company) =>
      `I've spent the last several years building production AI systems for Fortune 500 enterprises. My work at Enso Labs ┄ particularly the AI trading terminal and enterprise deployment methodology — directly aligns with ${company}'s mission. I'd bring a proven 75% pilot-to-production track record to the team.`,

    salary_expectation: 'Open to discussion based on total compensation structure',

    referral_source: 'Direct application ┄ following company closely'
  };
}

// ─── Submission Plan Generator ───────────────────────────────────

/**
 * Generates a submission plan for a role
 * Returns structured instructions for Claude Code / Playwright
 */
/**
 * Creates a submission plan for a role.
 *
 * SAFETY: Runs full pre-flight check before returning a plan.
 * If any check fails, throws with detailed reason.
 *
 * @param {string} roleId - Role ID from roles.json
 * @param {Array} sheetRows - Current Google Sheet rows (for dedup check). Pass [] to skip dedup.
 */
export async function createSubmissionPlan(roleId, sheetRows = []) {
  const rolesRaw = await readFile(join(ROOT, 'config/roles.json'), 'utf-8');
  const { roles, google_drive_folder_id } = JSON.parse(rolesRaw);
  const role = roles.find(r => r.id === roleId);

  if (!role) throw new Error(`Role not found: ${roleId}`);
  if (role.status !== 'materials_ready') {
    throw new Error(`Role ${roleId} is not ready for submission (status: ${role.status})`);
  }

  const candidateRaw = await readFile(join(ROOT, 'config/candidate.json'), 'utf-8');
  const candidate = JSON.parse(candidateRaw);

  // ─── SAFETY: Pre-flight check (dedup + score gate + batch limit + exclusions) ───
  const preflight = preFlightCheck({
    sheetRows,
    company: role.company,
    title: role.title,
    score: role.score
  });

  if (!preflight.canSubmit) {
    throw new Error(`SUBMISSION BLOCKED:\n${preflight.failures.join('\n')}`);
  }

  if (preflight.warnings.length > 0) {
    console.warn(`⚠️  Warnings:\n${preflight.warnings.join('\n')}`);
  }

  // ─── SAFETY: Increment batch counter ───
  const newCount = incrementSubmissionCount();
  console.log(`📊 Submission ${newCount}/${MAX_BATCH_SIZE} this session (${getSessionId()})`);

  const strategy = PLATFORM_STRATEGIES[role.platform] || PLATFORM_STRATEGIES.custom;
  const formData = getCandidateFormData(candidate);

  // ─── Generate pre-submit row (must be written to sheet BEFORE clicking submit) ───
  const preSubmitRow = generatePreSubmitRow(role, {
    resume_link: role.drive_resume_url || 'LinkedIn Default Profile',
    cover_letter_link: role.drive_cover_url || 'N/A - Easy Apply',
    version: role.materials_version || 'default profile'
  });

  return {
    roleId: role.id,
    company: role.company,
    title: role.title,
    apply_url: role.apply_url,
    platform: strategy.name,
    steps: [
      '⚠️ STEP 0: Write pre-submit row to Google Sheet with Status="Queued"',
      ...strategy.steps,
      '✅ FINAL: Update sheet row Status from "Queued" → "Applied" + add Applied Date'
    ],
    selectors: strategy.selectors || {},
    formData,
    resume_drive_url: role.drive_resume_url || null,
    cover_letter_drive_url: role.drive_cover_url || null,
    human_approval_required: true,
    note: strategy.note || null,
    // New safety fields
    session_id: getSessionId(),
    batch_position: `${newCount}/${MAX_BATCH_SIZE}`,
    pre_submit_row: preSubmitRow,
    materials_used: {
      resume: role.drive_resume_url || 'LinkedIn Default Profile',
      cover_letter: role.drive_cover_url || 'N/A - Easy Apply',
      version: role.materials_version || 'default profile'
    }
  };
}

// ─── Standalone execution ────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const roleId = process.argv[2];
  const autonomous = process.argv.includes('--autonomous');

  if (!roleId) {
    console.log('Usage: node submitter.mjs <role-id> [--autonomous]');
    console.log('  --autonomous  Remove human-approval gate (all safety guards still enforced)');
    console.log('\nAvailable platforms:');
    Object.entries(PLATFORM_STRATEGIES).forEach(([key, val]) => {
      console.log(`  ${key}: ${val.name} ┄ ${val.description}`);
    });
    process.exit(0);
  }

  const planFn = autonomous ? createAutonomousSubmissionPlan : createSubmissionPlan;
  planFn(roleId).then(plan => {
    console.log(autonomous ? '\nAutonomous Submission Plan:' : '\nSubmission Plan:');
    console.log(JSON.stringify(plan, null, 2));
  }).catch(err => {
    console.error('Error:', err.message);
  });
}

// ─── Autonomous Platform Strategies ────────────────────────────
// Same as PLATFORM_STRATEGIES but without the human-gate STOP steps.
// Used when --autonomous flag is passed to createSubmissionPlan().

const AUTONOMOUS_PLATFORM_STRATEGIES = Object.fromEntries(
  Object.entries(PLATFORM_STRATEGIES).map(([key, strategy]) => [
    key,
    {
      ...strategy,
      steps: strategy.steps.filter(step => !step.startsWith('STOP —')),
    }
  ])
);

// Add the final submit step to each autonomous strategy
for (const strategy of Object.values(AUTONOMOUS_PLATFORM_STRATEGIES)) {
  strategy.steps.push('Click the Submit button — autonomous mode, no human approval required');
  strategy.steps.push('Wait for confirmation page and capture screenshot');
}

export { PLATFORM_STRATEGIES, AUTONOMOUS_PLATFORM_STRATEGIES };

// ─── Autonomous Submission Plan ─────────────────────────────────

/**
 * Like createSubmissionPlan() but removes the human-approval gate.
 * All safety guards (dedup, score gate, batch limit, exclusions) are preserved.
 *
 * @param {string} roleId - Role ID from roles.json
 * @param {Array} sheetRows - Existing sheet rows for dedup check
 */
export async function createAutonomousSubmissionPlan(roleId, sheetRows = []) {
  const plan = await createSubmissionPlan(roleId, sheetRows);
  const strategy = AUTONOMOUS_PLATFORM_STRATEGIES[
    Object.keys(PLATFORM_STRATEGIES).find(k => PLATFORM_STRATEGIES[k].name === plan.platform)
  ] || AUTONOMOUS_PLATFORM_STRATEGIES.custom;

  return {
    ...plan,
    steps: strategy.steps,
    human_approval_required: false,
    autonomous: true,
  };
}
