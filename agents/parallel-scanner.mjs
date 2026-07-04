#!/usr/bin/env node
/**
 * Parallel Scanner — Lead + Source-Specialist Orchestration
 * ════════════════════════════════════════════════════════════════════════
 * Phase 1 of the Managed-Agents migration (see HANDOFF-jobagent-frontend-2026-06-02.md §3, §5, §8).
 *
 * WHAT THIS IS
 *   A LEAD orchestrator that fans out to one SOURCE SPECIALIST per job source,
 *   runs them in parallel, then fans the normalized results back in through the
 *   SAME `scoreRole()` + `roleQualificationGate()` used by the sequential scanner.
 *   Nothing about scoring or safety changes — only the scan becomes concurrent.
 *
 * WHY (from yesterday's decision)
 *   - Sequential source loop = slow + brittle (one source stalls the whole run).
 *   - Parallel specialists = each source is isolated; one failing source can't
 *     block the others (Promise.allSettled), and the run is as fast as the
 *     slowest single source instead of the sum of all sources.
 *
 * PROMOTION PATH — this file IS the Phase-1 → Phase-2 bridge
 *   Each entry in SOURCE_SPECIALISTS is a pluggable async fn `(ctx) => Role[]`.
 *   - Phase 1 (now): the lead = this Node process / a Cowork Agent run; each
 *     specialist fn is called locally (or by a spawned Cowork sub-agent).
 *   - Phase 2 (Managed Agents Multi-Agent Orchestration, launched May 2026):
 *     register each specialist as a hosted sub-agent (own model/prompt/scoped
 *     tools) under one lead agent on a shared filesystem. The lead's delegation
 *     contract is identical — `fanOut()` below maps 1:1 onto the orchestration
 *     `delegate()` call. No scoring/gate code moves; only the transport changes.
 *
 * SAFETY POSTURE (unchanged)
 *   - Hard filters (salary ≥ floor, NYC/remote, exclude list) run BEFORE scoreRole().
 *   - roleQualificationGate() (CS-degree + hands-on-IC) still gates auto-submit.
 *   - This file SCANS and SCORES only. It never submits. Submission stays
 *     sequential + human-gated in submitter.mjs / the Playwright daemon.
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  scoreRole,
  roleQualificationGate,
  EXCLUDE_COMPANIES,
  MINIMUM_SHEET_SCORE,
  HIGH_PROFILE_SCORE,
  AUTO_MATERIALS_SCORE,
} from './scanner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Hard filters (run BEFORE scoring; see memory: feedback_hard_filters) ──────
const SALARY_FLOOR = 180_000;            // FTE floor, per handoff §2
const HOURLY_FLOOR = 85;                 // Contract/consulting floor (added 2026-06-03, Sav request)
const PREFERRED_LOCATIONS = ['new york', 'nyc', 'remote', 'hybrid'];

/** Detect contract/consulting/hourly roles so they route to the hourly gate. */
function isContractRole(role) {
  const t = (role.title || '').toLowerCase();
  const s = String(role.salary ?? '').toLowerCase();
  const e = (role.employmentType || '').toLowerCase();
  return /contract|consult|fractional|interim|1099|w2|hourly|\/hr|per hour/.test(t + ' ' + s + ' ' + e);
}
/** Parse an hourly rate ceiling from a salary string, or null. */
function parseHourlyCeiling(raw) {
  if (raw == null) return null;
  const s = String(raw).toLowerCase();
  if (!/\/hr|per hour|hour|\$\d{2,3}\b/.test(s)) return null;
  const nums = (s.match(/\d{2,3}(?:\.\d+)?/g) || []).map(Number).filter(n => n > 0 && n < 1000);
  return nums.length ? Math.max(...nums) : null;
}

/** Parse a salary string/range to an upper bound in USD, or null if unknown.
 *  Handles: "USD 164,350.00 - 260,000.00", "$279K - $346K", "$183K", "$70 - $80" (hourly). */
function parseSalaryCeiling(raw) {
  if (raw == null) return null;
  const s = String(raw).toLowerCase();
  if (/depends on experience|compensation information|provided in the description/.test(s)) return null;
  // Capture each number with an optional k/m suffix so "346k" → 346000.
  const matches = [...s.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*([km])?/g)];
  const nums = matches
    .map(m => {
      let n = Number(m[1].replace(/,/g, ''));
      if (!n) return 0;
      if (m[2] === 'k') n *= 1_000;
      else if (m[2] === 'm') n *= 1_000_000;
      return n;
    })
    .filter(Boolean);
  if (!nums.length) return null;
  let max = Math.max(...nums);
  const hourly = /per hour|\/hr|\bhour\b/.test(s) || (max < 1000 && !/[km]\b/.test(s));
  if (hourly && max < 1000) max = max * 2080; // hourly → annual
  return max;
}

/** Returns { pass, reason }. Unknown salary is allowed through (JD fetch decides later). */
function passesHardFilters(role) {
  const company = (role.company || '').trim();
  if (EXCLUDE_COMPANIES.some(x => company.toLowerCase().includes(x.toLowerCase())))
    return { pass: false, reason: `excluded company (${company})` };

  // Two compensation tracks: FTE (≥ $180K) and contract/consulting (≥ $85/hr).
  if (isContractRole(role)) {
    const hr = parseHourlyCeiling(role.salary);
    if (hr != null && hr < HOURLY_FLOOR)
      return { pass: false, reason: `hourly $${hr}/hr < $${HOURLY_FLOOR}/hr` };
    // Unknown hourly rate passes through to JD-fetch (don't drop on missing data).
  } else {
    const ceiling = parseSalaryCeiling(role.salary);
    if (ceiling != null && ceiling < SALARY_FLOOR)
      return { pass: false, reason: `salary ceiling $${ceiling.toLocaleString()} < $${SALARY_FLOOR.toLocaleString()}` };
  }

  const loc = (role.location || '').toLowerCase();
  const isRemote = role.isRemote === true || /remote/.test(loc);
  if (loc && !isRemote && !PREFERRED_LOCATIONS.some(l => loc.includes(l)))
    return { pass: false, reason: `location "${role.location}" not NYC/remote` };

  return { pass: true };
}

// ── Normalization: every specialist must emit this shape ──────────────────────
/** @typedef {{title,company,location,salary,description,requirements,url,isRemote,source}} Role */
function normalize(raw, source) {
  return {
    title: raw.title || '',
    company: (raw.company || raw.companyName || '').trim(),
    location: raw.location || raw.jobLocation?.displayName || '',
    salary: raw.salary ?? null,
    description: raw.description || raw.summary || '',
    requirements: raw.requirements || '',
    url: raw.url || raw.detailsPageUrl || '',
    isRemote: raw.isRemote ?? false,
    source,
  };
}

// ── SOURCE SPECIALISTS ───────────────────────────────────────────────────────
// Each = one hosted sub-agent in Phase 2. Signature: async (ctx) => rawRole[].
// ctx carries injected fetchers so specialists stay transport-agnostic (the
// lead provides the MCP/Gmail/HTTP client; the specialist owns the query logic).
export const SOURCE_SPECIALISTS = {
  linkedin: {
    label: 'LinkedIn / Dice job MCP',
    // Mirrors Sav's LinkedIn saved-search parameters (replicated as keywords —
    // see note in PHASE1 doc on why we don't drive LinkedIn.com directly).
    keywords: ['agentic AI lead', 'AI transformation director', 'forward deployed engineer AI',
               'GenAI enablement director', 'AI strategy architect',
               'AI consultant', 'AI deployment strategist', 'applied AI consultant',
               'AI enablement lead', 'enterprise AI advisor'],
    async run(ctx) {
      if (!ctx.searchJobs) return [];
      const batches = await Promise.allSettled(
        this.keywords.map(k => ctx.searchJobs({ keyword: k, location: 'New York', posted_date: 'THREE' }))
      );
      return batches.flatMap(b => (b.status === 'fulfilled' ? (b.value?.data || []) : []));
    },
  },
  contract: {
    label: 'Contract / consulting boards ($85/hr+ track)',
    keywords: ['AI consultant contract', 'fractional AI lead', 'AI deployment strategist contract',
               'interim head of AI', 'AI architect contract'],
    async run(ctx) {
      if (!ctx.searchJobs) return [];
      const batches = await Promise.allSettled(
        this.keywords.map(k => ctx.searchJobs({ keyword: k, posted_date: 'THREE', employment_types: ['CONTRACTS'] }))
      );
      return batches.flatMap(b => (b.status === 'fulfilled' ? (b.value?.data || []) : []));
    },
  },
  ladders: {
    label: 'Ladders digest (ensopartners.co inbox)',
    async run(ctx) {
      if (!ctx.searchThreads) return [];
      const res = await ctx.searchThreads({ query: 'from:jobs@my.theladders.com newer_than:1d' });
      return (res?.threads || []).flatMap(t => ctx.parseLaddersRows?.(t) || []);
    },
  },
  jobright: {
    label: 'JobRight digest (personal Gmail bridge)',
    async run(ctx) {
      if (!ctx.personalGmail) return [];
      return ctx.personalGmail({ from: 'jobright.com', hours: 24 });
    },
  },
  // Add Indeed / Substack specialists here — same contract, no orchestrator change.
};

// ── LEAD: fan-out → fan-in → score → bucket ──────────────────────────────────
export async function fanOut(ctx, specialists = SOURCE_SPECIALISTS) {
  const entries = Object.entries(specialists);
  const settled = await Promise.allSettled(entries.map(([, s]) => s.run(ctx)));
  const raw = [];
  const errors = [];
  settled.forEach((r, i) => {
    const [key, s] = entries[i];
    if (r.status === 'fulfilled') raw.push(...r.value.map(x => normalize(x, key)));
    else errors.push({ source: key, label: s.label, error: String(r.reason) });
  });
  return { raw, errors };
}

/** Dedupe within the batch and against a Set of "company|title" keys already in Notion. */
function dedupe(roles, seenKeys = new Set()) {
  const out = [];
  const local = new Set();
  for (const r of roles) {
    const key = `${r.company}|${r.title}`.toLowerCase();
    const companyKey = r.company.toLowerCase();
    if (local.has(key) || seenKeys.has(key)) continue;
    // Company-level block: never apply to the same company twice (handoff rule).
    if ([...seenKeys].some(k => k.startsWith(companyKey + '|'))) { out.push({ ...r, _dupCompany: true }); local.add(key); continue; }
    local.add(key);
    out.push(r);
  }
  return out;
}

export async function runParallelScan(ctx = {}, notionSeenKeys = new Set()) {
  const { raw, errors } = await fanOut(ctx, ctx.specialists);
  const deduped = dedupe(raw, notionSeenKeys);

  const results = { autoMaterials: [], highProfile: [], tracked: [], skipped: [], errors };
  for (const role of deduped) {
    if (role._dupCompany) { results.skipped.push({ role, reason: 'company already in tracker' }); continue; }
    const hf = passesHardFilters(role);
    if (!hf.pass) { results.skipped.push({ role, reason: hf.reason }); continue; }

    const { score, breakdown } = scoreRole(role);
    const gate = roleQualificationGate(role);
    const scored = { ...role, score, breakdown, qualifies: gate.pass, gateReasons: gate.reasons };

    if (score >= AUTO_MATERIALS_SCORE && gate.pass) results.autoMaterials.push(scored);
    else if (score >= HIGH_PROFILE_SCORE) results.highProfile.push(scored);
    else if (score >= MINIMUM_SHEET_SCORE) results.tracked.push(scored);
    else results.skipped.push({ role: scored, reason: `score ${score} < ${MINIMUM_SHEET_SCORE}` });
  }
  [results.autoMaterials, results.highProfile, results.tracked].forEach(a => a.sort((x, y) => y.score - x.score));
  return results;
}

// ── CLI / smoke test ─────────────────────────────────────────────────────────
// `node agents/parallel-scanner.mjs` runs the lead with a fixture so the
// orchestration + scoring path is verifiable with no live credentials.
if (import.meta.url === `file://${process.argv[1]}`) {
  const fixturePath = join(__dirname, '..', 'fixtures', 'parallel-scan-fixture.json');
  let fixture = [];
  try { fixture = JSON.parse(await readFile(fixturePath, 'utf8')); } catch { /* no fixture */ }

  const ctx = {
    // One synthetic specialist that replays a saved scan, proving fan-in+scoring.
    specialists: { fixture: { label: 'fixture replay', run: async () => fixture } },
  };
  const out = await runParallelScan(ctx);
  const line = (r) => `  [${r.score}] ${r.title} — ${r.company}${r.qualifies ? '' : '  ⚠ gate: ' + r.gateReasons.join('; ')}`;
  console.log(`\nPARALLEL SCAN — ${fixture.length} roles in, ${Object.values(out).flat().length - out.errors.length} processed`);
  console.log(`\n8+ AUTO-MATERIALS (${out.autoMaterials.length}):`); out.autoMaterials.forEach(r => console.log(line(r)));
  console.log(`\n7  HIGH-PROFILE (${out.highProfile.length}):`); out.highProfile.forEach(r => console.log(line(r)));
  console.log(`\n5-6 TRACKED (${out.tracked.length}):`); out.tracked.forEach(r => console.log(line(r)));
  console.log(`\nSKIPPED (${out.skipped.length}):`); out.skipped.forEach(s => console.log(`  ${s.role.company} — ${s.reason}`));
  if (out.errors.length) console.log(`\nSOURCE ERRORS (${out.errors.length}):`, out.errors);
}
