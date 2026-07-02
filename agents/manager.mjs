#!/usr/bin/env node
/**
 * Manager Agent — the parallel orchestrator from docs/parallel-agent-architecture.html
 * ════════════════════════════════════════════════════════════════════════════
 *
 *        🧭 MANAGER (this file): plan · delegate · VALIDATE every output · own the gate + audit trail
 *                 ⤡                                   ⤢
 *   BACK END (parallel sub-agents)            FRONT END (live board)
 *   Gmail/Ladders · Indeed · Dice · Careers   Notion Career Command Center
 *        → Scorer (rubric 0–10)               → Click-ready shortlist (verified link + resume)
 *        → Dedup (shared key)                 → "Needs you" + status / audit trail
 *        → Tailor (resume pick + letter)
 *                 ⤡  both lanes meet at ONE keyed writer  ⤢
 *                        🔒 THE GATE — Sav approves
 *           Submit layer: Ladders Apply4Me · Simplify Copilot (v2: Browserbase, gated)
 *
 * WHAT THIS ADDS over agents/parallel-scanner.mjs (which only fans-out + scores):
 *   - Manager-level ACCEPTANCE CHECKS on every worker stage (validate-before-pass,
 *     so loops end in one round, not five — see docs/AGENT-MANAGER-DESIGN.md §1).
 *   - Cross-session KEYED dedup via lib/dedup.mjs through the ONE keyed writer
 *     (lib/notion-writer.keyedStage) — every insert checks dedupeKey() first.
 *   - TAILOR step: resume pick (lib/resume-picker) + a queued letter task.
 *   - The click-ready SHORTLIST + the "needs you" bucket = the front-end artifact.
 *   - Circuit breaker + structured run log + Agent Trail on every staged write.
 *   - Hard STOP at the human gate. This file SCANS, SCORES, DEDUPES, TAILORS and
 *     STAGES. It NEVER submits. Submission stays human-gated (Lane A, locked).
 *
 * RUN CONTRACT
 *   Live (Claude Code): pass a ctx with MCP-backed fetchers (searchJobs, searchThreads,
 *   personalGmail, …) and the current Notion rows (existingNotionRows from notion-search /
 *   lib/notion-queue.getRolesByStatus). The manager returns keyed insert payloads; the
 *   orchestrating Claude performs the actual notion-create-pages MCP writes.
 *   Offline (this CLI): `node agents/manager.mjs` replays reports/parallel-scan-fixture.json
 *   so the full delegate→validate→dedupe→tailor→stage→gate path is verifiable with no creds.
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { runParallelScan } from './parallel-scanner.mjs';
import { MINIMUM_SHEET_SCORE, HIGH_PROFILE_SCORE, AUTO_MATERIALS_SCORE } from './scanner.mjs';
import { keyedStage, buildAgentTrail } from '../lib/notion-writer.mjs';
import { pickResume } from '../lib/resume-picker.mjs';
import { dedupeKey, urlKey } from '../lib/dedup.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Acceptance checks (the manager's job is to PREVENT bad output passing on) ──

/** Scanner output is usable only if it can be deduped + staged: needs company + title. */
export function validateScannerRole(role = {}) {
  const reasons = [];
  if (!String(role.company || '').trim()) reasons.push('missing company');
  if (!String(role.title || '').trim()) reasons.push('missing title');
  return { ok: reasons.length === 0, reasons };
}

/** Scorer output must be a real 0–10 number. */
export function validateScore(score) {
  return typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 10;
}

/**
 * TAILOR stage, part 2 — the cover-letter task attached to every click-ready role.
 * The letter is ~80% fixed template (templates/master_cover_letter.md); only
 * OPENER / WHY_FIT_SECTIONS / CLOSER are generated per role. The orchestrating
 * Claude session executes this task (generate hooks JSON → fill template via
 * agents/auto-pipeline.generateCoverLetterDirect → docx if needed) and attaches
 * the draft to the Notion row. Sav reviews before it's ever sent — letters are
 * drafted automatically, approved humanly, same as the submit gate.
 */
export function buildLetterTask(role, resume) {
  return {
    template: 'templates/master_cover_letter.md',
    fill_via: 'agents/auto-pipeline.mjs → generateCoverLetterDirect(role, hooks, candidate)',
    rules: [
      'Under 400 words.',
      'Metrics VERBATIM from config/candidate.json verified_metrics — never invent or round.',
      'Reference at least one live URL (ensolabs.ai or ensolabs.ai/insights).',
      `Match the tone of the picked resume — ${resume.cluster}: ${resume.angle || ''}`,
      'No confidential client details beyond what the resumes themselves state.',
    ],
    generate: {
      opener: `1-2 sentences. Bold and specific to ${role.company} — lead with what Sav BUILDS, not what he wants.`,
      why_fit: '3-4 bullets mapping THIS job description\'s requirements to verified experience (each with an exact metric).',
      closer: '1-2 sentences connecting Sav\'s specific experience to their specific need. Confident, not pleading.',
    },
    jd_excerpt: `${role.description || ''} ${role.requirements || ''}`.trim().slice(0, 700),
  };
}

/** Why a staged role is NOT yet click-ready (drives the "needs you" bucket). */
function clickReadyGaps(role, resume) {
  const gaps = [];
  if (!(role.apply_url || role.url)) gaps.push('verify apply link — no clean ATS URL');
  if (!resume.exists) gaps.push(`resume PDF not on disk: ${resume.file}`);
  if (role.qualifies === false) gaps.push(`qualification gate: ${(role.gateReasons || []).join('; ')}`);
  if (role.score < AUTO_MATERIALS_SCORE) gaps.push(`score ${role.score} — tracking only (auto-materials ≥ ${AUTO_MATERIALS_SCORE})`);
  return gaps;
}

/**
 * Run the manager pipeline.
 * @param {object} ctx  - injected fetchers + { specialists } for the back-end fan-out.
 * @param {object} opts - { existingNotionRows, maxSourceErrors, breakerThreshold }
 * @returns full result: { runLog, shortlist, needsYou, stagedPayloads, duplicates, holds, gate, halted, haltReason }
 */
export async function runManager(ctx = {}, opts = {}) {
  const startedAt = new Date();
  const {
    existingNotionRows = [],
    maxSourceErrors = 3,
    breakerThreshold = 5,
  } = opts;

  // ── BACK END: delegate to the parallel source specialists (fan-out → score → bucket).
  // Pass empty notionSeenKeys: the manager owns the canonical cross-session dedup below.
  const scan = await runParallelScan(ctx, new Set());

  const shortlist = [];          // click-ready: verified link + resume + score≥auto + gate ok
  const needsYou = [];           // staged but flagged for Sav (missing link/resume/gate, or tracking)
  const stagedPayloads = [];     // keyed Notion insert payloads (Status="New") for the writer
  const duplicates = [];         // caught by the canonical keyed dedup
  const holds = [];              // acceptance failures (bad/unscorable rows)

  // knownRows grows as we stage, so a duplicate later in THIS batch is also caught
  // (idempotency — the same role arriving from two sources stages once).
  const knownRows = existingNotionRows.map((r) => ({ ...r }));

  // Candidates already passed hard filters + within-batch dedup + the qualification gate.
  const candidates = [...scan.autoMaterials, ...scan.highProfile, ...scan.tracked]
    .sort((a, b) => b.score - a.score);

  for (const role of candidates) {
    // ACCEPTANCE 1 — scanner output usable?
    const v = validateScannerRole(role);
    if (!v.ok) { holds.push({ stage: 'scanner', role, reasons: v.reasons }); continue; }
    // ACCEPTANCE 2 — score in range?
    if (!validateScore(role.score)) { holds.push({ stage: 'scorer', role, reasons: [`score out of range: ${role.score}`] }); continue; }

    // TAILOR — pick the pre-approved resume variant (does NOT regenerate).
    const resume = pickResume({ title: role.title, resumeVersion: role.resumeVersion || '' });

    const stageRole = {
      ...role,
      apply_url: role.url || role.apply_url || '',
      resume_cluster: resume.cluster,
      resume_file: resume.file,
      fit_reason: `Fit ${role.score}/10` +
        (role.breakdown?.matched_skills?.length ? ` — skills: ${role.breakdown.matched_skills.join(', ')}` : ''),
    };

    // ONE KEYED WRITER — check the shared dedup key BEFORE building any insert.
    const staged = keyedStage(
      stageRole,
      knownRows,
      { cluster: resume.cluster, file: resume.file, angle: resume.angle },
      { status: 'New', note: `source ${role.source}` },
    );
    if (staged.duplicate) { duplicates.push({ role: stageRole, ...staged }); continue; }

    // Register so the rest of this run dedupes against it too.
    knownRows.push({
      company: stageRole.company, title: stageRole.title,
      jobUrl: stageRole.apply_url, pageId: '(pending-this-run)', status: 'New',
    });
    stagedPayloads.push(staged.page);

    // FRONT END — sort into click-ready vs needs-you.
    const gaps = clickReadyGaps(role, resume);
    const entry = {
      company: stageRole.company,
      title: stageRole.title,
      score: role.score,
      url: stageRole.apply_url,
      location: role.location || '',
      salary: role.salary ?? '',
      source: role.source,
      resume_cluster: resume.cluster,
      resume_file: resume.file,
      resume_present: resume.exists,
      qualifies: role.qualifies !== false,
      key: staged.key,
      status: 'New',
    };
    if (gaps.length === 0) {
      shortlist.push({ ...entry, letter: buildLetterTask(role, resume) });
    } else {
      needsYou.push({ ...entry, reasons: gaps });
    }
  }

  // ── CIRCUIT BREAKER — halt + escalate after too many failures.
  const sourceErrors = scan.errors.length;
  const failures = sourceErrors + holds.length;
  const halted = sourceErrors >= maxSourceErrors || failures >= breakerThreshold;
  const haltReason = halted
    ? `circuit breaker: ${sourceErrors} source error(s) + ${holds.length} acceptance hold(s) (≥ ${breakerThreshold}, or sources ≥ ${maxSourceErrors})`
    : null;

  const finishedAt = new Date();
  const skippedByReason = scan.skipped.reduce((acc, s) => {
    const k = /score \d/.test(s.reason) ? 'below_threshold'
      : /excluded/.test(s.reason) ? 'excluded'
      : /company already/.test(s.reason) ? 'company_dup'
      : 'hard_filter';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  const runLog = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt - startedAt,
    sourcesRun: Object.keys(ctx.specialists || {}),
    sourceErrors: scan.errors,
    scanned: candidates.length + scan.skipped.length,
    passedFilters: candidates.length,
    skipped: skippedByReason,
    duplicatesSkipped: duplicates.length,
    holds: holds.length,
    staged: stagedPayloads.length,
    clickReady: shortlist.length,
    needsYou: needsYou.length,
  };

  // ── THE GATE — the manager owns it and never crosses it.
  const gate = {
    required: true,
    rule: 'No application is submitted without Sav. The manager only stages a shortlist.',
    enforcedBy: 'hooks/block-submit.mjs (PreToolUse, exit 2) + human approval in Notion',
    next: 'Review the shortlist in Notion → move rows to Status="Approved" → on the Mac run `npm run submit:notion` (Playwright fills, you click Submit).',
  };

  return { runLog, shortlist, needsYou, stagedPayloads, duplicates, holds, gate, halted, haltReason };
}

// ── CLI: replay the fixture so the whole path is verifiable with no creds ──────
function fmtEntry(e) {
  const mark = e.resume_present ? '' : ' ⚠resume-missing';
  return `  [${e.score}] ${e.title} — ${e.company}  (${e.resume_cluster}${mark})`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fixturePath = join(ROOT, 'fixtures', 'parallel-scan-fixture.json');
  let fixture = [];
  try { fixture = JSON.parse(await readFile(fixturePath, 'utf8')); }
  catch { console.error('No fixture at fixtures/parallel-scan-fixture.json'); process.exit(1); }

  // One synthetic source specialist replays the saved scan (Phase-2 swaps this for
  // hosted sub-agents; the lead's delegation contract is identical).
  const ctx = { specialists: { fixture: { label: 'fixture replay', run: async () => fixture } } };

  // Seed one row already on the board to prove CROSS-SESSION keyed dedup.
  const existingNotionRows = [
    { company: 'IAB Tech Lab', title: 'Head of Agentic Technologies',
      jobUrl: 'https://iabtechlab.com/tech-lab-careers/', pageId: 'existing-iab-001', status: 'New' },
  ];

  const out = await runManager(ctx, { existingNotionRows });

  console.log('\n🧭 MANAGER RUN — parallel-agent-architecture\n' + '═'.repeat(60));
  console.log(`scanned ${out.runLog.scanned} · passed ${out.runLog.passedFilters} · ` +
    `staged ${out.runLog.staged} · click-ready ${out.runLog.clickReady} · ` +
    `needs-you ${out.runLog.needsYou} · dup ${out.runLog.duplicatesSkipped} · holds ${out.runLog.holds}`);
  console.log('skipped:', JSON.stringify(out.runLog.skipped));

  console.log(`\n✅ CLICK-READY SHORTLIST (${out.shortlist.length}) — verified link + resume + gate:`);
  out.shortlist.forEach((e) => console.log(fmtEntry(e) + `  → ${e.url}`));
  if (!out.shortlist.length) console.log('  (none click-ready in this env — resume PDFs are gitignored/off-disk here)');

  console.log(`\n🔔 NEEDS YOU (${out.needsYou.length}) — staged to Notion, flagged for Sav:`);
  out.needsYou.forEach((e) => console.log(fmtEntry(e) + `\n        ↳ ${e.reasons.join(' | ')}`));

  console.log(`\n♻️  KEYED DEDUPE — skipped (${out.duplicates.length}):`);
  out.duplicates.forEach((d) => console.log(`  ${d.role.company} — ${d.role.title}  [${d.reason}]`));

  if (out.holds.length) {
    console.log(`\n⛔ ACCEPTANCE HOLDS (${out.holds.length}):`);
    out.holds.forEach((h) => console.log(`  ${h.stage}: ${h.reasons.join('; ')}`));
  }

  console.log(`\n🔒 GATE: ${out.gate.rule}\n   next → ${out.gate.next}`);
  if (out.halted) console.log(`\n🛑 HALTED — ${out.haltReason}`);

  console.log(`\n🧾 sample Agent Trail (on every staged write):\n   ${out.stagedPayloads[0]?.properties['Agent Trail'] || '(none)'}\n`);
}
