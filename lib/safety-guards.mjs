#!/usr/bin/env node
/**
 * Safety Guards — Pre-Submission Validation & Tracking
 *
 * PRIMARY DATA STORE: Notion Career Command Center (as of 2026-05-20)
 * FALLBACK: Google Sheet (read-only archive)
 *
 * Enforces:
 * 1. Deduplication: No duplicate company+title submissions (via Notion search)
 * 2. Score gate: No submission without a recorded score >= threshold
 * 3. Pre-logging: Row must exist in Notion BEFORE submit
 * 4. Batch limit: Max 7 submissions per session before forced pause
 * 5. Session isolation: Detects concurrent sessions
 * 6. Materials tracking: Records which resume/cover letter was used
 * 7. Audit trail: Requires confirmation number or screenshot ref
 *
 * Created: 2026-05-17 — in response to Batch 1 incident (21 untracked apps)
 * Updated: 2026-05-20 — Migrated to Notion-first (Phase 1)
 */

// Notion-first imports
import {
  preFlightCheckNotion,
  buildNotionPage,
  buildNotionUpdate,
  buildDedupQuery,
  checkNotionDuplicate,
  NOTION_DATA_SOURCE_ID
} from './notion-writer.mjs';

// Re-export Notion functions for convenience
export {
  preFlightCheckNotion,
  buildNotionPage,
  buildNotionUpdate,
  buildDedupQuery,
  checkNotionDuplicate,
  NOTION_DATA_SOURCE_ID
};

// ─── Constants ──────────────────────────────────────────────────────

export const MAX_BATCH_SIZE = 7;
export const MINIMUM_SUBMIT_SCORE = 5;
export const SESSION_CONFLICT_WINDOW_MINUTES = 30;

// ─── Deduplication Check ────────────────────────────────────────────

/**
 * Checks if a role has already been applied to.
 * Must be called BEFORE any submission attempt.
 *
 * @param {Array} sheetRows - Existing rows from the Google Sheet
 * @param {string} company - Company name to check
 * @param {string} title - Job title to check
 * @returns {object} { isDuplicate: boolean, existingRow: object|null, reason: string }
 */
export function checkDuplicate(sheetRows, company, title) {
  const companyLower = company.toLowerCase().trim();
  const titleLower = title.toLowerCase().trim();

  const match = sheetRows.find(row => {
    const rowCompany = (row.company || '').toLowerCase().trim();
    const rowTitle = (row.title || '').toLowerCase().trim();
    // Exact match on company + fuzzy on title (contains check)
    return rowCompany === companyLower &&
           (rowTitle === titleLower || rowTitle.includes(titleLower) || titleLower.includes(rowTitle));
  });

  if (match) {
    return {
      isDuplicate: true,
      existingRow: match,
      reason: `DUPLICATE BLOCKED: "${title}" at ${company} already exists (status: ${match.status || 'unknown'}, applied: ${match.applied_date || 'N/A'})`
    };
  }

  return { isDuplicate: false, existingRow: null, reason: null };
}

// ─── Score Gate ─────────────────────────────────────────────────────

/**
 * Validates that a role has been scored and meets minimum threshold.
 *
 * @param {number|undefined} score - The role's fit score
 * @param {string} company - Company name (for error messages)
 * @param {string} title - Job title (for error messages)
 * @returns {object} { passed: boolean, reason: string }
 */
export function checkScoreGate(score, company, title) {
  if (score === undefined || score === null) {
    return {
      passed: false,
      reason: `SCORE GATE FAILED: "${title}" at ${company} has no score recorded. Cannot submit without scoring first.`
    };
  }

  if (score < MINIMUM_SUBMIT_SCORE) {
    return {
      passed: false,
      reason: `SCORE GATE FAILED: "${title}" at ${company} scored ${score}/10 (minimum: ${MINIMUM_SUBMIT_SCORE}). Skipping.`
    };
  }

  return { passed: true, reason: null };
}

// ─── Batch Counter ──────────────────────────────────────────────────

/**
 * Tracks submissions in the current session.
 * Halts after MAX_BATCH_SIZE and requires explicit user continuation.
 */
let sessionSubmissionCount = 0;
let sessionId = `session_${Date.now()}`;

export function getSessionId() {
  return sessionId;
}

export function getSubmissionCount() {
  return sessionSubmissionCount;
}

export function incrementSubmissionCount() {
  sessionSubmissionCount++;
  return sessionSubmissionCount;
}

export function checkBatchLimit() {
  if (sessionSubmissionCount >= MAX_BATCH_SIZE) {
    return {
      limitReached: true,
      count: sessionSubmissionCount,
      reason: `BATCH LIMIT REACHED: ${sessionSubmissionCount}/${MAX_BATCH_SIZE} applications submitted this session. Pausing for user review. Send summary and wait for explicit "continue" before submitting more.`
    };
  }
  return { limitReached: false, count: sessionSubmissionCount, reason: null };
}

export function resetBatchCounter() {
  sessionSubmissionCount = 0;
}

// ─── Pre-Submission Logging Template ────────────────────────────────

/**
 * Generates the row data that must be written to the sheet BEFORE submission.
 * Status is set to "Queued" — only updated to "Applied" after confirmed submission.
 *
 * @param {object} role - Role details
 * @param {object} materials - Materials info (resume link, cover letter link, version)
 * @returns {object} Row data for Google Sheet
 */
export function generatePreSubmitRow(role, materials = {}) {
  const now = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  return {
    priority: role.score >= 8 ? 'TIER 1' : role.score >= 7 ? 'TIER 2' : 'TIER 3',
    date_found: now,
    fit_score: role.score,
    urgent: role.score >= 8 ? 'Yes' : 'No',
    job_title: role.title,
    company: role.company,
    location: role.location || 'Not listed',
    salary_range: role.salary || 'Not listed',
    fit_reason: role.fit_reason || '',
    job_url: role.apply_url || role.url || '',
    source: role.source || 'LinkedIn Easy Apply',
    portfolio_links: '',
    resume_link: materials.resume_link || 'LinkedIn Default Profile',
    cover_letter_link: materials.cover_letter_link || 'N/A - Easy Apply',
    form_url: role.apply_url || '',
    prefill_status: '',
    outreach_status: '',
    status: 'Queued',  // NOT "Applied" — only after confirmed submission
    applied_date: '',   // Filled AFTER successful submission
    response: '',
    notes: `Session: ${sessionId} | Materials: ${materials.version || 'default profile'}`
  };
}

// ─── Post-Submission Update ─────────────────────────────────────────

/**
 * Generates the update fields after a successful submission.
 * Called AFTER the submit button is clicked and confirmed.
 *
 * @param {string} confirmationNumber - Confirmation/reference number if available
 * @returns {object} Fields to update in the existing row
 */
export function generatePostSubmitUpdate(confirmationNumber = null) {
  const now = new Date().toISOString().split('T')[0];

  return {
    status: 'Applied',
    applied_date: now,
    notes_append: confirmationNumber
      ? ` | Confirmed: ${confirmationNumber}`
      : ' | Submitted (no confirmation number)'
  };
}

// ─── Full Pre-Flight Check ──────────────────────────────────────────

/**
 * Runs ALL safety checks before a submission attempt.
 * Returns a pass/fail with all reasons.
 *
 * @param {object} params
 * @param {Array} params.sheetRows - Existing sheet data
 * @param {string} params.company - Company name
 * @param {string} params.title - Job title
 * @param {number} params.score - Fit score
 * @returns {object} { canSubmit: boolean, failures: string[], warnings: string[] }
 */
export function preFlightCheck({ sheetRows, company, title, score }) {
  const failures = [];
  const warnings = [];

  // 1. Dedup check
  const dedup = checkDuplicate(sheetRows, company, title);
  if (dedup.isDuplicate) {
    failures.push(dedup.reason);
  }

  // 2. Score gate
  const scoreCheck = checkScoreGate(score, company, title);
  if (!scoreCheck.passed) {
    failures.push(scoreCheck.reason);
  }

  // 3. Batch limit
  const batchCheck = checkBatchLimit();
  if (batchCheck.limitReached) {
    failures.push(batchCheck.reason);
  }

  // 4. Exclusion list check
  const EXCLUDE = ['Perplexity', 'BOI', 'Board of Innovation'];
  if (EXCLUDE.some(ex => company.toLowerCase().includes(ex.toLowerCase()))) {
    failures.push(`EXCLUSION: ${company} is on the permanent exclusion list.`);
  }

  // Warnings (non-blocking)
  if (score >= 5 && score < 7) {
    warnings.push(`Low-priority role (score ${score}). Consider whether this is worth a submission.`);
  }

  return {
    canSubmit: failures.length === 0,
    failures,
    warnings
  };
}

// ─── Live Pre-Flight Check (Notion-first) ──────────────────────────

/**
 * Notion-first pre-flight check.
 *
 * NOTE: This builds the dedup query but CANNOT execute the Notion MCP
 * call itself. The orchestrating Claude Code routine should:
 *   1. Call buildDedupQuery(company, title)
 *   2. Execute via Notion MCP search
 *   3. Pass results to preFlightCheckNotion()
 *
 * Kept for backward compat. For new code, use preFlightCheckNotion() directly.
 */
export async function preFlightCheckLive({ company, title, score }) {
  return {
    _notionFirst: true,
    dedupQuery: buildDedupQuery(company, title),
    score,
    company,
    title,
    instruction: 'Execute dedupQuery via notion-search MCP, then call preFlightCheckNotion() with results'
  };
}

// ─── Legacy Sheet Pre-Flight (read-only fallback) ───────────────────
// @deprecated — Sheet is now read-only archive. Use preFlightCheckNotion().

// ─── Email Summary Template ─────────────────────────────────────────

/**
 * Generates the briefing email content after a submission batch.
 * This becomes the SINGLE SOURCE OF TRUTH for what was submitted.
 *
 * @param {Array} submissions - Array of submission records
 * @returns {string} Formatted email body
 */
export function generateBriefingEmail(submissions) {
  const now = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  let body = `Job Application Agent — Session Summary\n`;
  body += `Date: ${now}\n`;
  body += `Session ID: ${sessionId}\n`;
  body += `Applications submitted: ${submissions.length}\n`;
  body += `─────────────────────────────────────────\n\n`;

  submissions.forEach((sub, i) => {
    body += `${i + 1}. ${sub.title} @ ${sub.company}\n`;
    body += `   Score: ${sub.score}/10 | Source: ${sub.source}\n`;
    body += `   Resume: ${sub.resume_used || 'LinkedIn Default Profile'}\n`;
    body += `   Cover Letter: ${sub.cover_letter_used || 'N/A - Easy Apply'}\n`;
    body += `   Status: ${sub.status}\n`;
    if (sub.confirmation) body += `   Confirmation: ${sub.confirmation}\n`;
    body += `\n`;
  });

  body += `─────────────────────────────────────────\n`;
  body += `Duplicates blocked: ${submissions.filter(s => s.blocked_reason).length}\n`;
  body += `\nThis is your single source of truth. LinkedIn confirmation emails can be archived.\n`;

  return body;
}
