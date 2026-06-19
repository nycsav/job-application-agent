#!/usr/bin/env node
/**
 * Auto-Pipeline Agent — End-to-End Job Discovery → Materials Generation
 *
 * Chains the full pipeline:
 *   1. Scan Gmail for job alerts (LinkedIn, Indeed, Ladders, recruiter outreach)
 *   2. Extract job details from alert emails
 *   3. Score each role (0-10) using scanner's algorithm
 *   4. Run safety checks (dedup, score gate, exclusion list)
 *   5. Match best resume PDF from resume_map.json
 *   6. Generate cover letter via template engine (dynamic hook generation)
 *   7. Convert to ATS-optimized DOCX
 *   8. Upload to Google Drive
 *   9. Write to Notion Career Command Center (single source of truth)
 *  10. Send briefing email summary
 *
 * DESIGNED FOR: Claude Code Routine — 8 AM & 5 PM weekdays
 * SAFETY: Never auto-submits. Materials are generated and staged only.
 *
 * Created: 2026-05-19
 */

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { scoreRole, EXCLUDE_COMPANIES, MINIMUM_SHEET_SCORE, HIGH_PROFILE_SCORE, AUTO_MATERIALS_SCORE } from './scanner.mjs';
import { markdownToDocx, makeFilename } from '../lib/docx-builder.mjs';
import { loadCandidate, loadTemplate } from '../lib/template-engine.mjs';
// Notion-first (Phase 1 migration — 2026-05-20)
import {
  buildNotionPage,
  buildDedupQuery,
  checkNotionDuplicate,
  preFlightCheckNotion,
  generateBriefingEmail as generateNotionBriefingEmail,
  NOTION_DATA_SOURCE_ID
} from '../lib/notion-writer.mjs';
// Google Sheet legacy path retired 2026-06-19 — Notion is the single source of truth.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ─── Configuration ──────────────────────────────────────────────

const CONFIG_PATH = join(ROOT, 'config', 'pipeline.json');
const RESUME_MAP_PATH = join(ROOT, 'config', 'resume_map.json');

async function loadConfig() {
  return JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
}

async function loadResumeMap() {
  return JSON.parse(await readFile(RESUME_MAP_PATH, 'utf-8'));
}

// ─── Gmail Queries (from scanner.mjs) ───────────────────────────

const GMAIL_QUERIES = [
  // Cluster 1: AI transformation leadership
  'subject:(VP AI OR Director AI OR Head of AI OR Chief AI Officer OR AI Program Director OR AI transformation OR enterprise AI strategy) newer_than:8h -label:JobAgent/Processed',
  'from:linkedin.com subject:(VP OR Director OR Head) subject:(AI OR artificial intelligence OR transformation) newer_than:8h -label:JobAgent/Processed',
  // Cluster 2: AI architecture / technical
  'subject:(Solutions Architect AI OR AI Architect OR Principal AI Engineer OR Applied AI OR Technical AI Lead OR agentic systems OR Claude OR LLM OR AI infrastructure) newer_than:8h -label:JobAgent/Processed',
  'from:linkedin.com subject:(architect OR engineer OR principal) subject:(AI OR ML OR LLM) newer_than:8h -label:JobAgent/Processed',
  // Cluster 3: AI partnerships
  'subject:(Partner Director AI OR Alliance Manager OR BD AI OR Strategic Partnerships AI OR Partner Success OR ecosystem) newer_than:8h -label:JobAgent/Processed',
  // Cluster 4: AI strategy consulting
  'subject:(AI Strategy Consultant OR AI Advisory OR Strategy Director AI OR Management Consulting AI OR Digital Strategy OR AI consulting) newer_than:8h -label:JobAgent/Processed',
  // Catch-all: recruiter + Indeed
  'from:(recruiter OR talent OR hiring) subject:(AI OR artificial intelligence OR opportunity) newer_than:8h -label:JobAgent/Processed',
  'from:indeed.com subject:(job OR alert OR recommendation) subject:(AI OR strategy OR director OR VP) newer_than:8h -label:JobAgent/Processed',
];

// ─── Resume Matching ────────────────────────────────────────────

/**
 * Match a role to the best pre-approved resume PDF using resume_map.json rules.
 * Priority: title keywords → company type → JD content → default (ai_builder)
 *
 * @param {object} role - { title, company, description }
 * @param {object} resumeMap - Parsed resume_map.json
 * @returns {{ cluster: string, file: string, angle: string }}
 */
function matchResume(role, resumeMap) {
  const titleLower = (role.title || '').toLowerCase();
  const descLower = (role.description || '').toLowerCase();
  const companyLower = (role.company || '').toLowerCase();

  // Check each cluster's best_for titles
  for (const [cluster, config] of Object.entries(resumeMap.resumes)) {
    const titleMatch = config.best_for.some(t =>
      titleLower.includes(t.toLowerCase()) || t.toLowerCase().includes(titleLower)
    );
    if (titleMatch) {
      return { cluster, file: config.file, angle: config.angle };
    }
  }

  // Check by company type
  for (const [cluster, config] of Object.entries(resumeMap.resumes)) {
    if (config.example_companies) {
      const companyMatch = config.example_companies.some(c =>
        companyLower.includes(c.toLowerCase().split(' (')[0])
      );
      if (companyMatch) {
        return { cluster, file: config.file, angle: config.angle };
      }
    }
  }

  // Check by JD content keywords
  if (descLower.includes('consulting') || descLower.includes('advisory') || descLower.includes('transformation consultant')) {
    return { cluster: 'ai_advisory', ...resumeMap.resumes.ai_advisory };
  }
  if (descLower.includes('partnership') || descLower.includes('alliance') || descLower.includes('channel') || descLower.includes('co-sell')) {
    return { cluster: 'ai_partnerships', ...resumeMap.resumes.ai_partnerships };
  }
  if (descLower.includes('product marketing') || descLower.includes('gtm') || descLower.includes('go-to-market')) {
    return { cluster: 'product_marketing', ...resumeMap.resumes.product_marketing };
  }

  // Default
  const defaultCluster = resumeMap.matching_rules.default || 'ai_builder';
  return { cluster: defaultCluster, file: resumeMap.resumes[defaultCluster].file, angle: resumeMap.resumes[defaultCluster].angle };
}

// ─── Dynamic Cover Letter Hook Generation ───────────────────────

/**
 * Generate cover_letter_hooks from a job description.
 * This is the prompt that Claude will use to generate hooks dynamically.
 * The orchestrating Claude Code routine will call this to get the prompt,
 * then use its own LLM capability to fill in the hooks.
 *
 * @param {object} role - { title, company, description, location }
 * @param {object} candidate - Loaded candidate.json
 * @param {string} resumeAngle - The angle from the matched resume cluster
 * @returns {object} Prompt context for hook generation
 */
function buildHookGenerationContext(role, candidate, resumeAngle) {
  return {
    system: `You are generating cover letter hooks for Sav Banerjee's job application.

RULES:
- Use EXACT metrics from the candidate profile — never round or approximate
- Never mention confidential client names (use "Global Materials Manufacturer" for Gore)
- Reference at least one live portfolio URL (ensolabs.ai/work/*)
- Keep total cover letter under 400 words
- Match the tone of the resume angle: ${resumeAngle}

CANDIDATE METRICS (use exactly):
- Pilot-to-production rate: ${candidate.verified_metrics.pilot_to_production_rate}
- Campaign timeline reduction: ${candidate.verified_metrics.campaign_timeline_reduction}
- Documents processed: ${candidate.verified_metrics.documents_processed}
- Portfolio managed: ${candidate.verified_metrics.portfolio_managed}
- Revenue growth: ${candidate.verified_metrics.revenue_growth}

CERTIFICATIONS: ${candidate.certifications.map(c => c.name).join(', ')}`,

    prompt: `Generate cover_letter_hooks for this role:

Company: ${role.company}
Title: ${role.title}
Description: ${role.description || 'Not available'}

Return a JSON object with exactly this structure:
{
  "opener": "1-2 sentences. Bold, specific, not generic. Lead with what you BUILD, not what you want.",
  "why_fit": [
    "Point 1: Most relevant production system you've built (with exact metric)",
    "Point 2: Enterprise experience most relevant to this role (with exact metric)",
    "Point 3: Team/leadership proof point",
    "Point 4: Certification or credential most relevant to this company"
  ],
  "closer": "1-2 sentences. Connect your specific experience to their specific need. End with confidence, not pleading."
}

IMPORTANT: Return ONLY the JSON object, no markdown fences, no explanation.`
  };
}

// ─── Cover Letter Generation (Bypass Template Engine) ───────────

/**
 * Generate a cover letter markdown string directly, without requiring roles.json entry.
 * This bypasses the template engine's role lookup and works with dynamic data.
 *
 * @param {object} role - { title, company }
 * @param {object} hooks - { opener, why_fit[], closer }
 * @param {object} candidate - Loaded candidate.json
 * @returns {string} Filled cover letter markdown
 */
async function generateCoverLetterDirect(role, hooks, candidate) {
  let template = await loadTemplate('master_cover_letter.md');

  const whyFitSections = hooks.why_fit.map(point => `**${point}**`).join('\n\n');

  const primaryUrl = candidate.portfolio_urls.studio || 'ensolabs.ai';
  const portfolioCta = `I'd welcome the chance to walk through the live systems at ${primaryUrl}. Everything I'm describing is running in production, not hypothetical.`;

  const replacements = {
    '{{NAME}}': candidate.name,
    '{{LOCATION}}': candidate.location,
    '{{EMAIL}}': candidate.email,
    '{{PHONE}}': candidate.phone,
    '{{LINKEDIN}}': candidate.linkedin,
    '{{WEBSITE_PRIMARY}}': candidate.websites[0],
    '{{COMPANY}}': role.company,
    '{{TITLE}}': role.title,
    '{{OPENER}}': hooks.opener,
    '{{ROLE_CONTEXT}}': 'designing AI-powered architectures for enterprise customers and getting them to production',
    '{{WHY_FIT_SECTIONS}}': whyFitSections,
    '{{PORTFOLIO_CTA}}': portfolioCta,
    '{{CLOSER}}': hooks.closer
  };

  for (const [key, value] of Object.entries(replacements)) {
    template = template.replaceAll(key, value);
  }

  return template;
}

// ─── Sheet Row Builder ──────────────────────────────────────────

function buildSheetRow(role, resumeMatch, driveLinks = {}) {
  const now = new Date().toISOString().split('T')[0];
  return {
    priority: role.score >= 8 ? 'TIER 1' : role.score >= 7 ? 'TIER 2' : 'TIER 3',
    date_found: now,
    fit_score: role.score,
    urgent: role.score >= 8 ? 'Yes' : 'No',
    job_title: role.title,
    company: role.company,
    location: role.location || 'Not listed',
    salary_range: role.salary || 'Not listed',
    fit_reason: `Score breakdown: ${JSON.stringify(role.breakdown || {})}`,
    job_url: role.apply_url || role.url || '',
    source: role.source || 'LinkedIn Alert',
    portfolio_links: '',
    resume_link: driveLinks.resume_url || `PDF: ${resumeMatch.file}`,
    cover_letter_link: driveLinks.cover_letter_url || 'Pending upload',
    form_url: role.apply_url || '',
    prefill_status: '',
    outreach_status: '',
    status: 'Materials Ready',
    applied_date: '',
    response: '',
    notes: `Resume cluster: ${resumeMatch.cluster} | Auto-pipeline ${now}`
  };
}

// ─── Notion Page Builder (delegated to notion-writer.mjs) ──────
// Uses buildNotionPage() from notion-writer.mjs — the single source of truth
// for Career Command Center schema mapping. No more inline property definitions.

// ─── Briefing Email Generator ───────────────────────────────────

function generateBriefingEmail(results, stats) {
  const now = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
  const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  let body = `🤖 Auto-Pipeline Scan Complete\n`;
  body += `${now} at ${time}\n`;
  body += `═══════════════════════════════════════\n\n`;
  body += `Emails scanned: ${stats.emails_scanned}\n`;
  body += `Roles extracted: ${stats.roles_extracted}\n`;
  body += `Passed scoring (≥${MINIMUM_SHEET_SCORE}): ${stats.passed_scoring}\n`;
  body += `Duplicates blocked: ${stats.duplicates_blocked}\n`;
  body += `Excluded companies blocked: ${stats.exclusions_blocked}\n`;
  body += `Materials generated: ${stats.materials_generated}\n\n`;

  if (results.length === 0) {
    body += `No new qualifying roles found this scan.\n`;
    return body;
  }

  // Tier 1 first
  const tier1 = results.filter(r => r.score >= 8);
  const tier2 = results.filter(r => r.score >= 7 && r.score < 8);
  const tier3 = results.filter(r => r.score >= 5 && r.score < 7);

  if (tier1.length > 0) {
    body += `🔴 TIER 1 — URGENT (Score 8+)\n`;
    body += `───────────────────────────────────\n`;
    tier1.forEach((r, i) => {
      body += `${i + 1}. ${r.title} @ ${r.company} [${r.score}/10]\n`;
      body += `   Resume: ${r.resume_cluster} | Location: ${r.location || 'N/A'}\n`;
      body += `   ${r.apply_url || 'No URL'}\n\n`;
    });
  }

  if (tier2.length > 0) {
    body += `🟡 TIER 2 — HIGH PROFILE (Score 7)\n`;
    body += `───────────────────────────────────\n`;
    tier2.forEach((r, i) => {
      body += `${i + 1}. ${r.title} @ ${r.company} [${r.score}/10]\n`;
      body += `   Resume: ${r.resume_cluster}\n\n`;
    });
  }

  if (tier3.length > 0) {
    body += `⚪ TIER 3 — TRACKING (Score 5-6)\n`;
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

// ─── Main Pipeline (Orchestrated by Claude Code Routine) ────────

/**
 * PIPELINE STEPS — designed to be called step-by-step by Claude Code.
 *
 * The routine reads this file and executes each step using its own tools:
 *
 * Step 1: SCAN
 *   - Use Gmail MCP (search_threads) with each GMAIL_QUERIES entry
 *   - Extract thread IDs, subjects, snippets
 *   - Parse job details: title, company, location, apply_url, description
 *
 * Step 2: SCORE & FILTER
 *   - Call scoreRole() on each extracted role
 *   - Filter: skip score < 5, skip EXCLUDE_COMPANIES
 *   - Check dedup via the canonical keyed writer: keyedStage() / findDuplicate() (lib/dedup.mjs)
 *
 * Step 3: MATCH RESUME
 *   - Call matchResume() with the role and loaded resume_map.json
 *   - Returns { cluster, file, angle }
 *
 * Step 4: GENERATE COVER LETTER (score 8+ only)
 *   - Call buildHookGenerationContext() to get the prompt
 *   - Use Claude to generate hooks JSON from the JD
 *   - Call generateCoverLetterDirect() to fill the template
 *   - Call markdownToDocx() to convert to .docx buffer
 *
 * Step 5: UPLOAD MATERIALS
 *   - PRIMARY: Use Notion File Upload API (2-step: upload → attach to page)
 *   - FALLBACK: Google Drive MCP (create_file) — legacy, being retired
 *   - Materials: matched resume PDF + generated cover letter .docx
 *
 * Step 6: WRITE TO NOTION (single source of truth)
 *   - Use Notion MCP (notion-create-pages) with buildNotionPage()
 *     Data source: 931eceb1-d35d-46ca-9d4a-7fbfa48d3f99
 *   - DEDUP: keyedStage() checks the shared dedupeKey() BEFORE inserting; the
 *     buildDedupQuery() → notion-search → checkNotionDuplicate() path is the fallback.
 *
 * Step 7: SEND BRIEFING EMAIL
 *   - Use Gmail MCP (create_draft) with generateBriefingEmail()
 *   - To: sav@ensopartners.co (NEVER sav.banerjee@gmail.com)
 *   - Subject: "Job Agent: [date] [time] — [n] new roles"
 *   - References Notion Career Command Center as source of truth
 *
 * Step 8: LABEL PROCESSED
 *   - Label scanned threads with "JobAgent/Processed" (requires Gmail write)
 */

// ─── Exports for Claude Code Routine ────────────────────────────

export {
  GMAIL_QUERIES,
  matchResume,
  buildHookGenerationContext,
  generateCoverLetterDirect,
  buildSheetRow,
  generateBriefingEmail,
  EXCLUDE_COMPANIES,
  MINIMUM_SHEET_SCORE,
  HIGH_PROFILE_SCORE,
  AUTO_MATERIALS_SCORE,
  loadConfig,
  loadResumeMap,
};

// Re-export from dependencies
export { scoreRole } from './scanner.mjs';
export { markdownToDocx, makeFilename } from '../lib/docx-builder.mjs';
export { loadCandidate, loadTemplate } from '../lib/template-engine.mjs';

// Notion-first exports (primary)
export {
  buildNotionPage,
  buildDedupQuery,
  checkNotionDuplicate,
  preFlightCheckNotion,
  NOTION_DATA_SOURCE_ID
} from '../lib/notion-writer.mjs';

// Google Sheet legacy writer retired 2026-06-19 (Notion is the single source of truth).

// ─── Standalone test ────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2] || 'help';

  if (cmd === 'match-resume') {
    // Test resume matching: node auto-pipeline.mjs match-resume "VP AI Strategy" "McKinsey"
    const title = process.argv[3] || 'VP AI Strategy';
    const company = process.argv[4] || 'Test Company';
    const resumeMap = await loadResumeMap();
    const match = matchResume({ title, company, description: '' }, resumeMap);
    console.log(`Resume match for "${title}" @ ${company}:`);
    console.log(`  Cluster: ${match.cluster}`);
    console.log(`  File: ${match.file}`);
    console.log(`  Angle: ${match.angle}`);
  }

  else if (cmd === 'hook-prompt') {
    // Test hook generation prompt: node auto-pipeline.mjs hook-prompt "VP AI" "Anthropic" "Build enterprise AI solutions..."
    const candidate = await loadCandidate();
    const resumeMap = await loadResumeMap();
    const role = {
      title: process.argv[3] || 'VP AI Strategy',
      company: process.argv[4] || 'Test Company',
      description: process.argv[5] || 'Enterprise AI strategy and deployment role'
    };
    const match = matchResume(role, resumeMap);
    const ctx = buildHookGenerationContext(role, candidate, match.angle);
    console.log('=== SYSTEM ===');
    console.log(ctx.system);
    console.log('\n=== PROMPT ===');
    console.log(ctx.prompt);
  }

  else if (cmd === 'sheet-row') {
    // Test sheet row generation
    const resumeMap = await loadResumeMap();
    const role = {
      title: 'VP AI Strategy',
      company: 'Test Company',
      score: 8,
      location: 'New York, NY',
      source: 'LinkedIn Alert',
      breakdown: { title: 3, skills: 2, industry: 2, location: 1, compensation: 1 }
    };
    const match = matchResume(role, resumeMap);
    const row = buildSheetRow(role, match);
    console.log(JSON.stringify(row, null, 2));
  }

  else if (cmd === 'briefing') {
    // Test briefing email
    const results = [
      { title: 'VP AI Strategy', company: 'McKinsey', score: 9, resume_cluster: 'ai_advisory', location: 'NYC' },
      { title: 'Solutions Architect', company: 'Anthropic', score: 8, resume_cluster: 'ai_builder', location: 'SF', apply_url: 'https://boards.greenhouse.io/anthropic' },
      { title: 'AI Consultant', company: 'Deloitte', score: 6, resume_cluster: 'ai_advisory', location: 'Remote' }
    ];
    const stats = { emails_scanned: 24, roles_extracted: 8, passed_scoring: 3, duplicates_blocked: 2, exclusions_blocked: 1, materials_generated: 2 };
    console.log(generateBriefingEmail(results, stats));
  }

  else {
    console.log(`
Auto-Pipeline Agent — Test Commands:
  node auto-pipeline.mjs match-resume <title> <company>   Test resume matching
  node auto-pipeline.mjs hook-prompt <title> <company>     Show hook generation prompt
  node auto-pipeline.mjs sheet-row                         Test sheet row generation
  node auto-pipeline.mjs briefing                          Test briefing email format
    `);
  }
}
