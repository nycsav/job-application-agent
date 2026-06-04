#!/usr/bin/env node
/**
 * Notion Writer — Primary data store for the Job Application Pipeline
 *
 * Replaces sheet-writer.mjs as the single source of truth.
 * All pipeline data flows through the Career Command Center (Notion DB).
 *
 * This module is designed to be called by Claude Code routines that have
 * access to the Notion MCP. The functions here build the payloads;
 * the actual MCP calls are made by the orchestrating routine.
 *
 * Career Command Center data_source_id: 931eceb1-d35d-46ca-9d4a-7fbfa48d3f99
 * Career Command Center database_id: 8ce2a0e3-0ab3-4416-bcfe-81295f4e4991
 *
 * Created: 2026-05-20 — Phase 1 of Notion migration
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config', 'pipeline.json');

// ─── Constants ──────────────────────────────────────────────────

export const NOTION_DATABASE_ID = '8ce2a0e3-0ab3-4416-bcfe-81295f4e4991';
export const NOTION_DATA_SOURCE_ID = '931eceb1-d35d-46ca-9d4a-7fbfa48d3f99';

// Valid select options from the Career Command Center schema
export const VALID_STATUSES = [
  'New', 'Scoring', 'Tailoring', 'Materials Ready',
  'Approved', 'Applied', 'Interview', 'Offer', 'Rejected', 'Archived'
];

export const VALID_SOURCES = [
  'Dice', 'Indeed', 'LinkedIn', 'ZipRecruiter', 'Direct', 'Manual'
];

export const VALID_AUTOMATION_TIERS = ['Copilot', 'Autopilot', 'Autonomous'];

export const VALID_SOURCE_TIERS = [
  '1: Direct Referral',
  '2: Target Company',
  '3: Recruiter Outreach',
  '4: Job Board',
  '5: Cold Apply'
];

export const VALID_PILLARS = [
  'AI/ML', 'Product', 'Engineering', 'Strategy', 'Marketing'
];

export const VALID_PRIORITIES = ['DREAM', 'HIGH', 'MEDIUM', 'LOW'];

// ─── Source Mapping ─────────────────────────────────────────────

/**
 * Maps pipeline source strings to valid Notion Source select options.
 * The pipeline uses freeform strings like "LinkedIn Alert", "Gmail/Indeed", etc.
 * Notion Career Command Center only accepts specific select values.
 */
function mapSource(pipelineSource) {
  const src = (pipelineSource || '').toLowerCase();
  if (src.includes('linkedin')) return 'LinkedIn';
  if (src.includes('indeed')) return 'Indeed';
  if (src.includes('dice')) return 'Dice';
  if (src.includes('ziprecruiter')) return 'ZipRecruiter';
  if (src.includes('direct') || src.includes('referral')) return 'Direct';
  return 'Manual';
}

/**
 * Maps pipeline source to a Source Tier.
 */
function mapSourceTier(pipelineSource) {
  const src = (pipelineSource || '').toLowerCase();
  if (src.includes('referral') || src.includes('direct')) return '1: Direct Referral';
  if (src.includes('career page') || src.includes('target')) return '2: Target Company';
  if (src.includes('recruiter')) return '3: Recruiter Outreach';
  if (src.includes('linkedin') || src.includes('indeed') || src.includes('dice')) return '4: Job Board';
  return '5: Cold Apply';
}

/**
 * Maps score to priority.
 */
function mapPriority(score) {
  if (score >= 9) return 'DREAM';
  if (score >= 8) return 'HIGH';
  if (score >= 7) return 'MEDIUM';
  return 'LOW';
}

/**
 * Maps score to automation tier.
 */
function mapAutomationTier(score) {
  if (score >= 8) return 'Autopilot';    // Auto-generate materials
  if (score >= 7) return 'Copilot';      // Human monitors, agent assists
  return 'Copilot';                      // Track only
}

/**
 * Infers pillar from title keywords.
 */
function inferPillar(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('strategy') || t.includes('advisory') || t.includes('consulting') || t.includes('transformation')) return 'Strategy';
  if (t.includes('product') || t.includes('gtm') || t.includes('growth')) return 'Product';
  if (t.includes('engineer') || t.includes('architect') || t.includes('developer') || t.includes('technical')) return 'Engineering';
  if (t.includes('marketing') || t.includes('brand') || t.includes('content')) return 'Marketing';
  return 'AI/ML'; // Default — most roles Sav targets are AI-related
}

// ─── Page Builders ──────────────────────────────────────────────

/**
 * Builds the Notion page properties for a new role.
 * This is the payload for notion-create-pages MCP call.
 *
 * @param {object} role - { title, company, score, location, source, apply_url, salary, fit_reason, breakdown, strengths, gaps, ats_keywords }
 * @param {object} resumeMatch - { cluster, file, angle } from matchResume()
 * @param {object} options - { status, driveLinks }
 * @returns {object} Properties object for Notion MCP
 */
export function buildNotionPage(role, resumeMatch = {}, options = {}) {
  const now = new Date().toISOString().split('T')[0];
  const status = options.status || (role.score >= 8 ? 'Materials Ready' : 'New');

  const properties = {
    'Job Title': role.title,
    'Company': role.company,
    'Fit Score': role.score,
    'Location': role.location || 'Not listed',
    'Source': mapSource(role.source),
    'Status': status,
    'Automation Tier': mapAutomationTier(role.score),
    'Source Tier': mapSourceTier(role.source),
    'Pillar': inferPillar(role.title),
    'Priority': mapPriority(role.score),
    'Urgent': role.score >= 8 ? 'true' : 'false',
  };

  // Optional fields — only add if we have data
  if (role.apply_url || role.url) {
    properties['Job URL'] = role.apply_url || role.url;
  }
  if (role.salary) {
    properties['Salary Range'] = role.salary;
  }
  if (role.fit_reason || role.breakdown) {
    properties['Fit Reason'] = role.fit_reason || `Score: ${JSON.stringify(role.breakdown || {})}`;
  }
  if (role.strengths) {
    properties['Strengths'] = role.strengths;
  }
  if (role.gaps) {
    properties['Gaps'] = role.gaps;
  }
  if (role.ats_keywords) {
    properties['ATS Keywords'] = role.ats_keywords;
  }

  return {
    data_source_id: NOTION_DATA_SOURCE_ID,
    properties
  };
}

/**
 * Builds update payload for an existing Notion page.
 * Used after submission confirmation, status changes, etc.
 *
 * @param {string} pageId - The Notion page ID to update
 * @param {object} updates - Fields to update
 * @returns {object} Update payload for notion-update-page MCP call
 */
export function buildNotionUpdate(pageId, updates) {
  const properties = {};

  if (updates.status) properties['Status'] = updates.status;
  if (updates.applied_date) properties['Applied Date'] = updates.applied_date;
  if (updates.portfolio_links) properties['Portfolio Links'] = updates.portfolio_links;

  return { page_id: pageId, properties };
}

// ─── Dedup Check ────────────────────────────────────────────────

/**
 * Builds the search query to check for duplicates in Career Command Center.
 * The orchestrating Claude Code routine will execute this via notion-search MCP.
 *
 * @param {string} company - Company name
 * @param {string} title - Job title
 * @returns {object} Search parameters for the Notion MCP
 */
export function buildDedupQuery(company, title) {
  return {
    query: `${company} ${title}`,
    data_source_url: `collection://${NOTION_DATA_SOURCE_ID}`,
    page_size: 5,
    max_highlight_length: 50
  };
}

/**
 * Checks dedup results from Notion search.
 * Called after the orchestrating routine executes the search.
 *
 * @param {Array} searchResults - Results from notion-search
 * @param {string} company - Company name to match
 * @param {string} title - Job title to match
 * @returns {object} { isDuplicate, existingPageId, reason }
 */
export function checkNotionDuplicate(searchResults, company, title) {
  const companyLower = company.toLowerCase().trim();
  const titleLower = title.toLowerCase().trim();

  for (const result of searchResults) {
    const resultTitle = (result.title || '').toLowerCase().trim();
    // Check if the result title contains the job title AND the highlight/context mentions the company
    const highlight = (result.highlight || '').toLowerCase();
    const resultText = `${resultTitle} ${highlight}`;

    const titleMatch = resultText.includes(titleLower) || titleLower.includes(resultTitle);
    const companyMatch = resultText.includes(companyLower);

    if (titleMatch && companyMatch) {
      return {
        isDuplicate: true,
        existingPageId: result.id,
        reason: `DUPLICATE BLOCKED: "${title}" at ${company} already exists in Career Command Center (page: ${result.id})`
      };
    }
  }

  return { isDuplicate: false, existingPageId: null, reason: null };
}

// ─── Pre-Flight Check (Notion-First) ───────────────────────────

/**
 * Runs all safety checks using Notion as the data source.
 * Replaces the Google Sheet-based preFlightCheck.
 *
 * Note: The dedup check requires a prior Notion search call.
 * Pass the search results in notionSearchResults.
 *
 * @param {object} params
 * @param {Array} params.notionSearchResults - Results from notion-search dedup query
 * @param {string} params.company
 * @param {string} params.title
 * @param {number} params.score
 * @param {number} params.sessionSubmitCount - Current session submission count
 * @param {number} params.maxBatch - Max submissions per session (default 7)
 * @returns {object} { canSubmit, failures, warnings }
 */
export function preFlightCheckNotion({
  notionSearchResults = [],
  company,
  title,
  score,
  sessionSubmitCount = 0,
  maxBatch = 7
}) {
  const failures = [];
  const warnings = [];

  // 1. Dedup
  const dedup = checkNotionDuplicate(notionSearchResults, company, title);
  if (dedup.isDuplicate) {
    failures.push(dedup.reason);
  }

  // 2. Score gate
  if (score === undefined || score === null) {
    failures.push(`SCORE GATE FAILED: "${title}" at ${company} has no score. Cannot proceed.`);
  } else if (score < 5) {
    failures.push(`SCORE GATE FAILED: "${title}" at ${company} scored ${score}/10 (minimum: 5).`);
  }

  // 3. Batch limit
  if (sessionSubmitCount >= maxBatch) {
    failures.push(`BATCH LIMIT: ${sessionSubmitCount}/${maxBatch} submissions this session. Pause and review.`);
  }

  // 4. Exclusion list
  const EXCLUDE = ['Perplexity', 'BOI', 'Board of Innovation'];
  if (EXCLUDE.some(ex => company.toLowerCase().includes(ex.toLowerCase()))) {
    failures.push(`EXCLUSION: ${company} is permanently blacklisted.`);
  }

  // Warnings
  if (score >= 5 && score < 7) {
    warnings.push(`Low-priority role (score ${score}). Worth a submission?`);
  }

  return {
    canSubmit: failures.length === 0,
    failures,
    warnings
  };
}

// ─── Briefing Email (Notion-aware) ─────────────────────────────

/**
 * Generates briefing email referencing Notion as source of truth.
 */
export function generateBriefingEmail(results, stats) {
  const now = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
  const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  let body = `Auto-Pipeline Scan Complete\n`;
  body += `${now} at ${time}\n`;
  body += `═══════════════════════════════════════\n\n`;
  body += `Emails scanned: ${stats.emails_scanned}\n`;
  body += `Roles extracted: ${stats.roles_extracted}\n`;
  body += `Passed scoring (>=5): ${stats.passed_scoring}\n`;
  body += `Duplicates blocked: ${stats.duplicates_blocked}\n`;
  body += `Excluded companies blocked: ${stats.exclusions_blocked}\n`;
  body += `Materials generated: ${stats.materials_generated}\n\n`;

  if (results.length === 0) {
    body += `No new qualifying roles found this scan.\n`;
    return body;
  }

  const tier1 = results.filter(r => r.score >= 8);
  const tier2 = results.filter(r => r.score >= 7 && r.score < 8);
  const tier3 = results.filter(r => r.score >= 5 && r.score < 7);

  if (tier1.length > 0) {
    body += `TIER 1 — URGENT (Score 8+)\n`;
    body += `───────────────────────────────────\n`;
    tier1.forEach((r, i) => {
      body += `${i + 1}. ${r.title} @ ${r.company} [${r.score}/10]\n`;
      body += `   Resume: ${r.resume_cluster} | Location: ${r.location || 'N/A'}\n`;
      body += `   ${r.apply_url || 'No URL'}\n\n`;
    });
  }

  if (tier2.length > 0) {
    body += `TIER 2 — HIGH PROFILE (Score 7)\n`;
    body += `───────────────────────────────────\n`;
    tier2.forEach((r, i) => {
      body += `${i + 1}. ${r.title} @ ${r.company} [${r.score}/10]\n`;
      body += `   Resume: ${r.resume_cluster}\n\n`;
    });
  }

  if (tier3.length > 0) {
    body += `TIER 3 — TRACKING (Score 5-6)\n`;
    body += `───────────────────────────────────\n`;
    tier3.forEach((r, i) => {
      body += `${i + 1}. ${r.title} @ ${r.company} [${r.score}/10]\n`;
    });
  }

  body += `\n═══════════════════════════════════════\n`;
  body += `Notion Career Command Center updated.\n`;
  body += `https://www.notion.so/8ce2a0e30ab34416bcfe81295f4e4991\n`;
  body += `Reply "submit [company]" to trigger Submitter Agent.\n`;

  return body;
}

// ─── CLI Test ──────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2] || 'help';

  if (cmd === 'build-page') {
    const role = {
      title: 'VP AI Strategy',
      company: 'McKinsey',
      score: 9,
      location: 'New York, NY',
      source: 'LinkedIn Alert',
      apply_url: 'https://mckinsey.com/careers/123',
      salary: '$250k-$350k',
      fit_reason: 'Perfect fit: consulting + AI strategy',
      breakdown: { title: 3, skills: 3, industry: 2, location: 1, compensation: 1 }
    };
    const page = buildNotionPage(role, { cluster: 'ai_advisory' });
    console.log(JSON.stringify(page, null, 2));
  }

  else if (cmd === 'preflight') {
    const result = preFlightCheckNotion({
      notionSearchResults: [],
      company: 'McKinsey',
      title: 'VP AI Strategy',
      score: 9,
      sessionSubmitCount: 0
    });
    console.log('Pre-flight:', result);
  }

  else if (cmd === 'briefing') {
    const results = [
      { title: 'VP AI Strategy', company: 'McKinsey', score: 9, resume_cluster: 'ai_advisory', location: 'NYC' },
      { title: 'Solutions Architect', company: 'Anthropic', score: 8, resume_cluster: 'ai_builder', location: 'SF' },
    ];
    const stats = { emails_scanned: 24, roles_extracted: 8, passed_scoring: 3, duplicates_blocked: 2, exclusions_blocked: 1, materials_generated: 2 };
    console.log(generateBriefingEmail(results, stats));
  }

  else {
    console.log(`
Notion Writer — Test Commands:
  node notion-writer.mjs build-page     Build sample Notion page payload
  node notion-writer.mjs preflight      Test pre-flight check
  node notion-writer.mjs briefing       Test briefing email format
    `);
  }
}
