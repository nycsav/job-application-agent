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
export async function createSubmissionPlan(roleId) {
  const rolesRaw = await readFile(join(ROOT, 'config/roles.json'), 'utf-8');
  const { roles, google_drive_folder_id } = JSON.parse(rolesRaw);
  const role = roles.find(r => r.id === roleId);

  if (!role) throw new Error(`Role not found: ${roleId}`);
  if (role.status !== 'materials_ready') {
    throw new Error(`Role ${roleId} is not ready for submission (status: ${role.status})`);
  }

  const candidateRaw = await readFile(join(ROOT, 'config/candidate.json'), 'utf-8');
  const candidate = JSON.parse(candidateRaw);

  // Check exclusion list
  if (candidate.exclude_companies.some(ex => role.company.toLowerCase().includes(ex.toLowerCase()))) {
    throw new Error(`${role.company} is on the exclusion list. Skipping.`);
  }

  const strategy = PLATFORM_STRATEGIES[role.platform] || PLATFORM_STRATEGIES.custom;
  const formData = getCandidateFormData(candidate);

  return {
    roleId: role.id,
    company: role.company,
    title: role.title,
    apply_url: role.apply_url,
    platform: strategy.name,
    steps: strategy.steps,
    selectors: strategy.selectors || {},
    formData,
    resume_drive_url: role.drive_resume_url || null,
    cover_letter_drive_url: role.drive_cover_url || null,
    human_approval_required: true,
    note: strategy.note || null
  };
}

// ─── Standalone execution ────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const roleId = process.argv[2];

  if (!roleId) {
    console.log('Usage: node submitter.mjs <role-id>');
    console.log('\nAvailable platforms:');
    Object.entries(PLATFORM_STRATEGIES).forEach(([key, val]) => {
      console.log(`  ${key}: ${val.name} ┄ ${val.description}`);
    });
    process.exit(0);
  }

  createSubmissionPlan(roleId).then(plan => {
    console.log('\nSubmission Plan:');
    console.log(JSON.stringify(plan, null, 2));
  }).catch(err => {
    console.error('Error:', err.message);
  });
}

export { PLATFORM_STRATEGIES };
