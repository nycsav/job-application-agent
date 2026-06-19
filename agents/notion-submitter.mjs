#!/usr/bin/env node
/**
 * Notion Submitter — gated apply path driven by the Notion approved-queue.
 *
 * This is the "Submitter Agent on the approved Notion roles" path. It replaces
 * the old roles.json/Google-Sheet coupling: it reads roles you've moved to
 * Status="Approved" in the Career Command Center, builds a per-role form plan
 * using the existing platform strategies, and hands each plan to Claude Code +
 * Playwright to execute — STOPPING before every Submit for your approval.
 *
 * After a confirmed submit, it writes Status→Applied + Applied Date back to Notion.
 *
 * DESIGNED FOR: Claude Code with Playwright MCP, running on your Mac.
 *   node agents/notion-submitter.mjs            # build + print the gated queue
 *   node agents/notion-submitter.mjs --dry-run  # same, no Notion writes implied
 *
 * SAFETY: never auto-submits. The Submit step is performed by Claude Code under
 * the PreToolBatch human-approval hook. markApplied() runs only after you confirm.
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getApprovedRoles, markApplied } from '../lib/notion-queue.mjs';
import { PLATFORM_STRATEGIES, getCandidateFormData } from './submitter.mjs';
import { preFlightCheckNotion } from '../lib/notion-writer.mjs';
import { pickResume } from '../lib/resume-picker.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const EXCLUDE = ['Perplexity', 'BOI', 'Board of Innovation'];

/**
 * Build the gated submission plan for one approved Notion role.
 * Mirrors submitter.createSubmissionPlan but sourced from Notion, not roles.json.
 */
function buildPlan(role, candidate, sessionCount, maxBatch) {
  const preflight = preFlightCheckNotion({
    notionSearchResults: [],          // dedup already enforced at staging time
    company: role.company,
    title: role.title,
    score: role.score ?? 5,           // Approved implies it cleared the gate
    sessionSubmitCount: sessionCount,
    maxBatch,
  });
  if (!preflight.canSubmit) {
    return { roleId: role.pageId, company: role.company, title: role.title, blocked: preflight.failures };
  }

  const strategy = PLATFORM_STRATEGIES[role.platform] || PLATFORM_STRATEGIES.custom;
  const resume = pickResume({ title: role.title, resumeVersion: role.resumeVersion });
  const warnings = [...preflight.warnings];
  if (!resume.exists) {
    warnings.push(`RESUME FILE MISSING on disk: ${resume.file} — upload it to materials/resumes/ before submitting.`);
  }
  return {
    pageId: role.pageId,
    company: role.company,
    title: role.title,
    apply_url: role.jobUrl,
    platform: strategy.name,
    resume_cluster: resume.cluster,
    resume_file: resume.file,
    resume_path: resume.absPath,
    resume_present: resume.exists,
    steps: [
      ...strategy.steps,
      `📎 Upload resume PDF: ${resume.absPath}`,
      '✅ AFTER human-approved submit: call markApplied(pageId) → Notion Status=Applied + Applied Date',
      '✅ THEN: move the source email to the AI-Applied Gmail label',
    ],
    selectors: strategy.selectors || {},
    formData: { ...getCandidateFormData(candidate), resume_path: resume.absPath },
    note: strategy.note || null,
    human_approval_required: true,
    warnings,
  };
}

/** Read the approved queue and return per-role gated plans. */
export async function runApprovedQueue({ maxBatch = 7 } = {}) {
  const candidate = JSON.parse(await readFile(join(ROOT, 'config/candidate.json'), 'utf-8'));
  const roles = (await getApprovedRoles())
    .filter((r) => !EXCLUDE.some((ex) => (r.company || '').toLowerCase().includes(ex.toLowerCase())));

  const plans = [];
  let count = 0;
  for (const role of roles.slice(0, maxBatch)) {
    plans.push(buildPlan(role, candidate, count, maxBatch));
    count++;
  }
  return { total_approved: roles.length, plans };
}

/** Call AFTER a confirmed, human-approved submission. */
export async function confirmApplied(pageId, confirmation = '') {
  return markApplied(pageId, { confirmation });
}

// ─── CLI ────────────────────────────────────────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runApprovedQueue()
    .then(({ total_approved, plans }) => {
      console.log(`\n=== NOTION SUBMITTER — ${total_approved} approved role(s) ===\n`);
      if (plans.length === 0) {
        console.log('No roles at Status="Approved". Approve roles in the Career Command Center first.\n');
        return;
      }
      plans.forEach((p, i) => {
        if (p.blocked) {
          console.log(`${i + 1}. ⛔ ${p.company} — ${p.title}\n   BLOCKED: ${p.blocked.join('; ')}\n`);
          return;
        }
        console.log(`${i + 1}. 📋 ${p.company} — ${p.title}  [${p.platform}]`);
        console.log(`   Apply: ${p.apply_url || '(no URL — open via company careers)'}`);
        console.log(`   Resume: ${p.resume_file} ${p.resume_present ? '✅' : '❌ MISSING'}`);
        if (p.warnings?.length) console.log(`   ⚠️  ${p.warnings.join(' | ')}`);
        console.log(`   → Claude Code + Playwright fills this, then STOPS before Submit for approval.\n`);
      });
      console.log('Run this under Claude Code with Playwright MCP to execute the gated submits.\n');
    })
    .catch((err) => { console.error('Error:', err.message); process.exit(1); });
}
