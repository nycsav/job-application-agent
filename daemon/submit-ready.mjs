#!/usr/bin/env node
/**
 * Submit Ready — autonomous Notion "Materials Ready" queue submitter.
 *
 * 1. Queries Notion Career Command Center for Status = "Materials Ready"
 * 2. Validates each role: exclusion list, score gate ($180K FTE / $85/hr floor)
 * 3. Detects ATS platform from Job URL
 * 4. Fills & submits via Playwright (Greenhouse, Ashby, Lever)
 *    - LinkedIn → skipped here (handled by easy-apply-bot / run-once daemon)
 *    - Tier 3 (Workday, iCIMS, Oracle) → logged as manual, not changed in Notion
 * 5. Updates Notion Status to "Applied" on success
 * 6. Writes briefing to .logs/submit-ready-*.json + output/briefings/submit-ready-*.txt
 *
 * Auth:
 *   NOTION_API_KEY env var  — or write key to .secrets/notion-token.txt
 *
 * Flags:
 *   --dry-run        Query + validate but never open a browser
 *   --max <n>        Cap submissions per run (default 7)
 *   --platform <p>   Only process roles on this platform (greenhouse|ashby|lever)
 *   --hours-back <n> Not used here — all Materials Ready are eligible regardless of age
 *
 * Run manually:
 *   node daemon/submit-ready.mjs --dry-run
 *   node daemon/submit-ready.mjs --max 3
 *   node daemon/submit-ready.mjs --platform greenhouse
 *
 * Installed via launchd:
 *   cp daemon/launchd/com.sav.job-auto-submit.plist ~/Library/LaunchAgents/
 *   launchctl load ~/Library/LaunchAgents/com.sav.job-auto-submit.plist
 */

import { chromium } from 'playwright';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { existsSync, mkdirSync, readdirSync, unlinkSync, readFileSync, writeFileSync, appendFileSync, openSync, closeSync } from 'fs';
import { execSync } from 'child_process';
import { applyTo } from './easy-apply-bot.mjs';
import { loadAnswers, matchAnswer, numericAnswer } from './canned-answers.mjs';
import { markdownToDocx } from '../lib/docx-builder.mjs';
import { selectResume as routerSelectResume, verifyResumes } from '../lib/resume-router.mjs';
import { applyToDice } from './dice-adapter.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const LOG_DIR = join(ROOT, '.logs');
const AUDIT_ROOT = join(ROOT, '.audit');
const BRIEF_DIR = join(ROOT, 'output', 'briefings');

// ─── Constants ────────────────────────────────────────────────────

const NOTION_DB_ID = '8ce2a0e3-0ab3-4416-bcfe-81295f4e4991';
const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const SALARY_FLOOR_FTE = 180_000;
const SALARY_FLOOR_HOURLY = 85;
const MIN_SCORE = 5;
const DEFAULT_MAX_BATCH = 7;

const EXCLUDE_COMPANIES = [
  'perplexity', 'boi', 'board of innovation', 'sia partners', 'sia experience'
];

// Platforms handled here (autonomous Playwright)
const AUTONOMOUS_PLATFORMS = new Set(['greenhouse', 'ashby', 'lever']);
// Platforms that need manual submission — leave Notion status unchanged, just report
const MANUAL_PLATFORMS = new Set(['workday', 'icims', 'oracle_hcm', 'google_careers']);

// ─── CLI args ─────────────────────────────────────────────────────

function cliArg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) return true; // boolean flag
  return v;
}

let DRY_RUN = cliArg('dry-run', false) === true; // may be forced true by the single-submitter guard
let forcedDryRun = false; // set when the guard downgrades a live run (surfaced in the briefing)
const MOCK_RUN = cliArg('mock', false) === true; // fake Notion data for dry-run verification
const MAX_SUBMISSIONS = Number(cliArg('max', DEFAULT_MAX_BATCH));
const PLATFORM_FILTER = cliArg('platform', null);
const HEADLESS = process.env.HEADLESS !== 'false';

// ─── Single-submitter guard + single-instance lock ─────────────────
// TWO atomic layers guarantee exactly ONE submitting process globally — the only
// airtight defense against double-submission across machines. (A Notion "lock"
// can't be atomic: Notion has no compare-and-set, so two writers can straddle
// each other's read-back — proven in the dedup-hardening audit, 2026-06-16.)
//
//  (1) CROSS-MACHINE: only the host holding .secrets/submitter.allow (gitignored,
//      never in git) may LIVE-submit. Fail-CLOSED — an absent marker forces
//      dry-run, never the reverse. Put the marker on ONLY the Mac Mini → exactly
//      one machine ever writes to a posting. (File-presence, NOT os.hostname():
//      macOS Bonjour names drift and would silently lock out the real runner.)
//  (2) SAME-MACHINE: a local O_EXCL lockfile is a TRUE mutex on one filesystem,
//      blocking an overlapping cron+manual run. Stale locks (dead PID / age > TTL)
//      are reclaimed; released on exit, conditional on still owning it.
const SUBMITTER_MARKER = join(ROOT, '.secrets', 'submitter.allow');
const LOCK_PATH = join(ROOT, '.secrets', 'submit-ready.lock');
// 2h backstop. A LIVE holder's batch finishes in well under this, and a live PID
// is never stolen mid-batch (the reclaim also requires age>TTL); a dead/stuck lock
// clears after 2h. Bumped from 30 min so a slow 7-role batch can't be reclaimed under it.
const LOCK_TTL_MS = 2 * 60 * 60 * 1000;

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function writeLockFile() {
  const fd = openSync(LOCK_PATH, 'wx'); // O_EXCL: atomic create-or-fail
  writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() }));
  closeSync(fd);
}
function acquireInstanceLock() {
  try { writeLockFile(); return true; }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let holder = {};
    try { holder = JSON.parse(readFileSync(LOCK_PATH, 'utf-8')); } catch {}
    const ageMs = holder.at ? (Date.now() - Date.parse(holder.at)) : Infinity;
    const alive = holder.pid ? isPidAlive(holder.pid) : false;
    if (!alive || ageMs > LOCK_TTL_MS) {
      console.warn(`[submit-ready] reclaiming stale lock (pid ${holder.pid}, age ${Math.round(ageMs / 1000)}s, alive=${alive})`);
      try { unlinkSync(LOCK_PATH); } catch {}
      try { writeLockFile(); return true; } catch { return false; }
    }
    return false; // a live sibling run holds it
  }
}
function releaseInstanceLock() {
  try {
    const holder = JSON.parse(readFileSync(LOCK_PATH, 'utf-8'));
    if (holder.pid === process.pid) unlinkSync(LOCK_PATH);
  } catch { /* no lock / not ours / already gone — fine */ }
}

// ─── Crash-safe submit ledger ──────────────────────────────────────
// Two local files close the "submitted but the record was lost" seam — a Notion
// write failing AFTER a confirmed submit, or a crash in the window right after the
// irreversible click. Both would otherwise leave the row "Materials Ready" and the
// next run would re-submit. (Impl-review holes #1/#2/#3, 2026-06-16.)
//  • submit-inflight.json — written just before each submit, cleared only once a
//    TERMINAL Notion state (Applied or Needs Review) is recorded. A leftover marker
//    at the next run's start means a role was interrupted mid-submit → it's
//    quarantined to Needs Review (verify; never blind-resubmit).
//  • applied-pageids.log — every confirmed submit's page_id, appended BEFORE the
//    Notion write, so a confirmed application can never reappear as eligible even if
//    every Notion write fails. (Same-machine; the single-submitter marker keeps it
//    to one machine, so a local ledger is sufficient.)
const INFLIGHT_PATH = join(ROOT, '.secrets', 'submit-inflight.json');
const APPLIED_LOG = join(ROOT, '.secrets', 'applied-pageids.log');
const appliedPageIds = (() => {
  try { return new Set(readFileSync(APPLIED_LOG, 'utf-8').split('\n').map(s => s.trim()).filter(Boolean)); }
  catch { return new Set(); }
})();
function recordAppliedPageId(pageId) {
  appliedPageIds.add(pageId);
  try { appendFileSync(APPLIED_LOG, pageId + '\n'); } catch {}
}
function setInflight(pageId, label) {
  try { writeFileSync(INFLIGHT_PATH, JSON.stringify({ page_id: pageId, label, at: new Date().toISOString() })); } catch {}
}
function clearInflight() { try { if (existsSync(INFLIGHT_PATH)) unlinkSync(INFLIGHT_PATH); } catch {} }
function readInflight() { try { return JSON.parse(readFileSync(INFLIGHT_PATH, 'utf-8')); } catch { return null; } }

// ─── Notion REST client ────────────────────────────────────────────

async function loadNotionKey() {
  if (process.env.NOTION_API_KEY) return process.env.NOTION_API_KEY;
  const tokenPath = join(ROOT, '.secrets', 'notion-token.txt');
  if (existsSync(tokenPath)) return (await readFile(tokenPath, 'utf-8')).trim();
  throw new Error(
    'Notion API key not found. Set NOTION_API_KEY env var or write key to .secrets/notion-token.txt'
  );
}

async function notionFetch(method, endpoint, body, key, attempt = 1) {
  // Retry transient network failures (e.g. "fetch failed") up to 3x with backoff
  // so a momentary blip doesn't abort the whole run. Caught 2026-06-16.
  let res;
  try {
    res = await fetch(`${NOTION_API_BASE}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 1500 * attempt));
      return notionFetch(method, endpoint, body, key, attempt + 1);
    }
    throw new Error(`Notion ${method} ${endpoint} → network error after ${attempt} tries: ${err.message}`);
  }
  const json = await res.json();
  if (!res.ok) {
    // Retry Notion 5xx / rate-limit (429) too
    if ((res.status >= 500 || res.status === 429) && attempt < 3) {
      await new Promise(r => setTimeout(r, 1500 * attempt));
      return notionFetch(method, endpoint, body, key, attempt + 1);
    }
    throw new Error(`Notion ${method} ${endpoint} → ${res.status}: ${json.message || JSON.stringify(json).slice(0, 200)}`);
  }
  return json;
}

// Statuses eligible for submission. "Approved" = Sav explicitly green-lit;
// "Materials Ready" = staged by the scan routine.
const SUBMIT_STATUSES = ['Approved', 'Materials Ready'];

async function querySubmitQueue(key) {
  const pages = [];
  let cursor = undefined;
  do {
    const body = {
      filter: { or: SUBMIT_STATUSES.map(s => ({ property: 'Status', select: { equals: s } })) },
      sorts: [{ property: 'Fit Score', direction: 'descending' }],
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    };
    const result = await notionFetch('POST', `/databases/${NOTION_DB_ID}/query`, body, key);
    pages.push(...(result.results || []));
    cursor = result.has_more ? result.next_cursor : undefined;
  } while (cursor);
  return pages;
}

// Company+title normalized key for dedup across statuses and runs.
// Stopwords stripped so "Manager, Solutions Architecture" == "Manager of Solutions Architecture".
function dedupKey(company, title) {
  const stop = /\b(of|the|and|a|an|for|to|in|at|on|with)\b/g;
  const norm = (s) => String(s || '').toLowerCase().replace(stop, ' ').replace(/[^a-z0-9]+/g, '');
  return `t:${norm(company)}::${norm(title)}`;
}

// Normalized apply-URL key — catches same posting listed under variant titles.
function urlKey(u) {
  if (!u) return null;
  const s = String(u).toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '')
    .split(/[?#]/)[0].replace(/\/+$/, '');
  return s ? `u:${s}` : null;
}

async function queryAppliedKeys(key) {
  const keys = new Map();
  let cursor = undefined;
  do {
    const body = {
      // Broaden beyond Status=Applied: anything that's been applied to OR is in a
      // terminal/review state is a dedup anchor (catches a reopened Applied row, or
      // one the other machine just moved). Broadening can only ADD dedup blocks,
      // never permit a double-submit. (Audit 2026-06-16, gap "snapshot-only".)
      filter: { or: [
        { property: 'Applied Date', date: { is_not_empty: true } },
        ...['Applied', 'Needs Review', 'Interview', 'Offer', 'Rejected'].map(s => ({ property: 'Status', select: { equals: s } })),
      ] },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    };
    const result = await notionFetch('POST', `/databases/${NOTION_DB_ID}/query`, body, key);
    for (const page of result.results || []) {
      const r = extractPageFields(page);
      const desc = `${r.title} @ ${r.company} (applied ${page.properties?.['Applied Date']?.date?.start || '?'})`;
      keys.set(dedupKey(r.company, r.title), desc);
      const uk = urlKey(r.apply_url);
      if (uk) keys.set(uk, desc);
    }
    cursor = result.has_more ? result.next_cursor : undefined;
  } while (cursor);
  return keys;
}

async function setNotionArchived(pageId, key, reason, existingFitReason = '') {
  const today = new Date().toISOString().split('T')[0];
  const note = `[DEDUP ${today}] ${reason}${existingFitReason ? ' | ' + existingFitReason : ''}`.slice(0, 1900);
  return notionFetch('PATCH', `/pages/${pageId}`, {
    properties: {
      Status: { select: { name: 'Archived' } },
      'Fit Reason': { rich_text: [{ text: { content: note } }] },
    },
  }, key);
}

// Generic status setter — used to quarantine an ambiguous submit to "Needs Review"
// so it is NEVER auto-resubmitted. Notion auto-creates a missing select option.
async function setNotionStatus(pageId, key, status, note = '', existingFitReason = '') {
  const props = { Status: { select: { name: status } } };
  if (note) props['Fit Reason'] = { rich_text: [{ text: { content: `${note}${existingFitReason ? ' | ' + existingFitReason : ''}`.slice(0, 1900) } }] };
  return notionFetch('PATCH', `/pages/${pageId}`, { properties: props }, key);
}

// Live re-read right before an irreversible submit. Another process — or the other
// machine, were the marker ever duplicated — may have applied since the start-of-run
// snapshot. Read-only → can only SKIP, never strand/deadlock a row. On ANY uncertainty
// it returns NOT eligible (bias to never-twice; the role simply retries a later run).
async function stillEligible(pageId, apiKey) {
  if (appliedPageIds.has(pageId)) return { eligible: false, status: 'already submitted (local ledger)' };
  try {
    const page = await notionFetch('GET', `/pages/${pageId}`, null, apiKey);
    const status = page.properties?.['Status']?.select?.name || '';
    const appliedDate = page.properties?.['Applied Date']?.date?.start;
    if (appliedDate) return { eligible: false, status: `already applied ${appliedDate}` };
    if (!SUBMIT_STATUSES.includes(status)) return { eligible: false, status: `status now "${status}"` };
    return { eligible: true, status };
  } catch (e) {
    return { eligible: false, status: `re-check failed: ${e.message}` };
  }
}

// Maps internal platform keys → the Notion "Platform" select option names.
function platformLabel(p) {
  const m = { greenhouse: 'Greenhouse', ashby: 'Ashby', lever: 'Lever', linkedin: 'LinkedIn',
    workday: 'Workday', indeed: 'Indeed', dice: 'Dice', icims: 'iCIMS', oracle_hcm: 'Oracle',
    custom: 'Custom', google_careers: 'Custom', apply4me: 'Apply4Me' };
  return m[String(p || '').toLowerCase()] || 'Custom';
}
function urlOrigin(u) { try { return new URL(u).origin; } catch { return ''; } }

// Marks a role Applied AND records the audit trail Sav asked for (2026-06-15):
// today's date, resume version, personalized cover letter, platform, and the
// company/application links — so each row is a complete, non-duplicable record.
async function setNotionApplied(pageId, key, meta = {}) {
  const today = new Date().toISOString().split('T')[0];
  const props = {
    Status: { select: { name: 'Applied' } },
    'Applied Date': { date: { start: today } },
  };
  if (meta.resume) props['Resume Version'] = { rich_text: [{ text: { content: String(meta.resume).slice(0, 200) } }] };
  if (meta.coverLetter) props['Cover Letter'] = { rich_text: [{ text: { content: String(meta.coverLetter).slice(0, 200) } }] };
  if (meta.platform) props['Platform'] = { select: { name: platformLabel(meta.platform) } };
  if (meta.companyUrl) props['Company URL'] = { url: String(meta.companyUrl).slice(0, 1900) };
  if (meta.applyUrl) props['Job URL'] = { url: String(meta.applyUrl).slice(0, 1900) };
  return notionFetch('PATCH', `/pages/${pageId}`, { properties: props }, key);
}

// ─── Extract Notion page fields ───────────────────────────────────

function extractPageFields(page) {
  const p = page.properties || {};
  const txt = (prop) => {
    if (!prop) return '';
    if (prop.title) return prop.title.map(t => t.plain_text).join('');
    if (prop.rich_text) return prop.rich_text.map(t => t.plain_text).join('');
    if (prop.select) return prop.select?.name || '';
    if (prop.url !== undefined) return prop.url || '';
    if (prop.number !== undefined) return prop.number;
    return '';
  };
  return {
    page_id: page.id,
    title:      String(txt(p['Job Title'])),
    company:    String(txt(p['Company'])),
    score:      p['Fit Score']?.number ?? null,
    status:     p['Status']?.select?.name || '',
    apply_url:  String(txt(p['Job URL'])),
    salary_text: String(txt(p['Salary Range'])),
    location:   String(txt(p['Location'])),
    source:     String(txt(p['Source'])),
    fit_reason: String(txt(p['Fit Reason'])),
    strengths:  String(txt(p['Strengths'])),
  };
}

// ─── Platform detection ────────────────────────────────────────────

function detectPlatform(url) {
  if (!url) return 'unknown';
  if (/boards\.greenhouse\.io|greenhouse\.io\/embed/i.test(url)) return 'greenhouse';
  if (/jobs\.ashbyhq\.com|app\.ashbyhq\.com/i.test(url)) return 'ashby';
  if (/jobs\.lever\.co/i.test(url)) return 'lever';
  if (/linkedin\.com\/jobs/i.test(url)) return 'linkedin';
  if (/careers\.google\.com|google\.com\/about\/careers/i.test(url)) return 'google_careers';
  if (/myworkdayjobs\.com|workday\.com/i.test(url)) return 'workday';
  if (/icims\.com/i.test(url)) return 'icims';
  if (/taleo\.net|oraclecloud\.com|oracle\.com/i.test(url)) return 'oracle_hcm';
  if (/dice\.com/i.test(url)) return 'dice';
  return 'custom';
}

// ─── Resume selection ──────────────────────────────────────────────

let _candidateCache = null;
async function loadCandidate() {
  if (_candidateCache) return _candidateCache;
  const raw = await readFile(join(ROOT, 'config', 'candidate.json'), 'utf-8');
  _candidateCache = JSON.parse(raw);
  return _candidateCache;
}

// Delegates to lib/resume-router.mjs — the SINGLE SOURCE OF TRUTH for resume
// selection, shared with easy-apply-bot and dice-adapter so the latest 2026
// resume can never drift between submitters. Routing rules live in candidate.json.
async function selectResume(company, title) {
  return routerSelectResume(company, title);
}

async function buildFormData() {
  const c = await loadCandidate();
  return {
    first_name: c.name.split(' ')[0],
    last_name: c.name.split(' ').slice(1).join(' '),
    full_name: c.name,
    email: c.email,
    phone: c.phone,
    linkedin_url: `https://${c.linkedin}`,
    website: `https://${c.websites[0]}`,
    current_company: c.current_company,
    current_title: c.current_title,
    location: c.location,
  };
}

// ─── Cover letters ──────────────────────────────────────────────────
// Every submission carries a customized cover letter. A hand-written letter
// in output/cover-letters/ with the exact slug wins; otherwise one is
// generated from verified_metrics with role-aware emphasis. Never fabricates
// metrics; never names confidential clients.

const CL_DIR = join(ROOT, 'output', 'cover-letters');

function slugify(s) {
  return String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '').slice(0, 70);
}

function stripMarkdownToText(md) {
  return md
    .replace(/^---\s*$/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildFitBullets(role, c) {
  const themes = `${role.title} ${role.fit_reason} ${role.strengths} ${role.company}`.toLowerCase();
  const u = c.portfolio_urls || {};
  const bullets = [];
  if (/financ|bank|asset|capital|invest|card|payment|fintech|insur|wealth|trading/.test(themes)) {
    bullets.push(`**Financial services depth.** I manage a $150MM+ Fortune 500 portfolio including Citi, JPMorgan Chase, American Express, and Goldman Sachs, and have built production financial AI agents on Claude + MCP + brokerage APIs (${u.trading_terminal || 'ensolabs.ai'}). I was an invited attendee at the May 2026 Anthropic Financial Services Briefing.`);
  }
  if (/pharma|health|life.?science|medical|patient|fda|mlr|biotech|clinical/.test(themes)) {
    bullets.push(`**Regulated-industry AI that ships.** At Heller I designed and launched an AI Center of Excellence under FDA/MLR compliance for global pharma — 75% pilot-to-production conversion, 83% reduction in campaign launch timelines (3 months to 2 weeks), and 35% time savings across five brand teams (${u.healthcare || 'ensolabs.ai'}).`);
  }
  if (/agent|claude|anthropic|llm|gen[\s-]?ai|copilot|mcp|orchestrat|solutions architect/.test(themes)) {
    bullets.push(`**Production agentic systems, not decks.** Claude Certified Architect (Anthropic, 2026). I build human+AI orchestration on Claude + MCP that runs in production — one pipeline processed 731 documents in a single run and surfaced 16 novel commercial signals (${u.enterprise_ai || 'ensolabs.ai'}).`);
  }
  if (/market|gtm|brand|campaign|growth|commercial|customer success/.test(themes)) {
    bullets.push(`**Marketing and GTM operator.** I ran a $6B digital & social analytics portfolio for AT&T, led teams at McCann, RAPP, and Rokkan (AdAge Top 10 Agency 2012), and doubled agency revenue over two years at Heller — 65% faster reporting, 83% faster campaign launches.`);
  }
  if (/consult|advisor|transform|strategy|enablement|change|operating model|coe|center of excellence|director|vp|head of/.test(themes)) {
    bullets.push(`**Transformation leadership.** 15+ years advising Fortune 500 enterprises (Citi, JPMorgan Chase, American Express, Google, Microsoft, T-Mobile), building and leading 8-15 person teams that reach production within 90 days, with a 3-month average time-to-first-value.`);
  }
  if (bullets.length < 3) {
    bullets.push(`**Pilot-to-production discipline.** 75% of my AI pilots convert to production because every engagement starts as an architecture problem — scoping what AI can own, what needs human-in-the-loop, and how to ship in under three months (${u.studio || 'ensolabs.ai'}).`);
  }
  return bullets.slice(0, 3);
}

function buildCoverLetterMarkdown(role, c) {
  const u = c.portfolio_urls || {};
  const bullets = buildFitBullets(role, c);
  const hook = (role.fit_reason || '').trim();
  const opener = hook
    ? `The ${role.title} mandate maps directly onto work I already do: ${hook.charAt(0).toLowerCase()}${hook.slice(1).replace(/\.*$/, '.')}`
    : `The ${role.title} role calls for someone who can turn AI strategy into production systems that teams actually adopt — that has been my work for the last four years as founder of Enso Labs.`;
  return `${c.name}
${c.location}
${c.email} | ${c.phone}
${c.linkedin} | ${u.studio || (c.websites && c.websites[0]) || ''}

---

${role.company}
${role.title}

---

Dear ${role.company} Hiring Team,

${opener}

As the founder of Enso Labs, I've spent the last several years doing exactly what this role demands. My 75% pilot-to-production conversion rate exists because I treat every engagement as an architecture problem first — scoping what AI can own, what needs human-in-the-loop, and how to get from pilot to production in under three months.

Three reasons I fit ${role.company}:

${bullets.join('\n\n')}

I'm a Claude Certified Architect, Perplexity AI Business Fellowship winner, and 15+ year strategist based in New York. I would welcome a conversation about how ${role.company} can move from AI ambition to AI in production.

${c.name}
`;
}

/**
 * Find or generate the customized cover letter for a role.
 * Exact-slug match in output/cover-letters/ wins (hand-written letters);
 * otherwise generates .md + ATS-safe .docx. Returns { docxPath, mdPath, text }.
 */
async function ensureCoverLetter(role) {
  if (!existsSync(CL_DIR)) mkdirSync(CL_DIR, { recursive: true });
  const c = await loadCandidate();
  const base = `${slugify(role.company)}_${slugify(role.title)}`;
  const mdPath = join(CL_DIR, `${base}.md`);

  let md;
  if (existsSync(mdPath)) {
    md = await readFile(mdPath, 'utf-8');
  } else {
    md = buildCoverLetterMarkdown(role, c);
    await writeFile(mdPath, md);
  }

  const docxPath = mdPath.replace(/\.md$/, '.docx');
  if (!existsSync(docxPath)) {
    const buf = await markdownToDocx(md);
    await writeFile(docxPath, buf);
  }
  return { docxPath, mdPath, text: stripMarkdownToText(md) };
}

// ─── Mock data for dry-run verification ───────────────────────────

const MOCK_PAGES = [
  {
    id: 'mock-001',
    properties: {
      'Job Title': { title: [{ plain_text: 'VP AI Strategy' }] },
      'Company': { rich_text: [{ plain_text: 'McKinsey' }] },
      'Fit Score': { number: 9 },
      'Status': { select: { name: 'Materials Ready' } },
      'Job URL': { url: 'https://boards.greenhouse.io/mckinsey/jobs/mock-vp-ai' },
      'Salary Range': { rich_text: [{ plain_text: '$300K–$400K' }] },
      'Location': { rich_text: [{ plain_text: 'New York, NY (Hybrid)' }] },
      'Source': { select: { name: 'LinkedIn' } },
    },
  },
  {
    id: 'mock-002',
    properties: {
      'Job Title': { title: [{ plain_text: 'Head of AI Solutions' }] },
      'Company': { rich_text: [{ plain_text: 'OpenAI' }] },
      'Fit Score': { number: 8 },
      'Status': { select: { name: 'Materials Ready' } },
      'Job URL': { url: 'https://jobs.ashbyhq.com/openai/mock-head-of-ai' },
      'Salary Range': { rich_text: [{ plain_text: '$250K–$350K' }] },
      'Location': { rich_text: [{ plain_text: 'Remote' }] },
      'Source': { select: { name: 'Direct' } },
    },
  },
  {
    id: 'mock-003',
    properties: {
      'Job Title': { title: [{ plain_text: 'AI Solutions Director' }] },
      'Company': { rich_text: [{ plain_text: 'Cuesta Partners' }] },
      'Fit Score': { number: 8 },
      'Status': { select: { name: 'Materials Ready' } },
      'Job URL': { url: 'https://jobs.lever.co/cuestapartners/mock-ai-director' },
      'Salary Range': { rich_text: [{ plain_text: '$220K–$280K' }] },
      'Location': { rich_text: [{ plain_text: 'New York, NY' }] },
      'Source': { select: { name: 'LinkedIn' } },
    },
  },
  {
    id: 'mock-004-excluded',
    properties: {
      'Job Title': { title: [{ plain_text: 'AI Researcher' }] },
      'Company': { rich_text: [{ plain_text: 'Perplexity' }] },
      'Fit Score': { number: 9 },
      'Status': { select: { name: 'Materials Ready' } },
      'Job URL': { url: 'https://boards.greenhouse.io/perplexity/jobs/mock' },
      'Salary Range': { rich_text: [{ plain_text: '$300K+' }] },
      'Location': { rich_text: [{ plain_text: 'Remote' }] },
      'Source': { select: { name: 'LinkedIn' } },
    },
  },
  {
    id: 'mock-005-manual',
    properties: {
      'Job Title': { title: [{ plain_text: 'Senior AI Director' }] },
      'Company': { rich_text: [{ plain_text: 'JPMorgan Chase' }] },
      'Fit Score': { number: 8 },
      'Status': { select: { name: 'Materials Ready' } },
      'Job URL': { url: 'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/mock' },
      'Salary Range': { rich_text: [{ plain_text: '$280K–$350K' }] },
      'Location': { rich_text: [{ plain_text: 'New York, NY' }] },
      'Source': { select: { name: 'LinkedIn' } },
    },
  },
];

// ─── Safety validation ─────────────────────────────────────────────

function parseSalaryMax(text) {
  if (!text) return null;
  const matches = [...text.matchAll(/\$?([\d,.]+)\s*[Kk]?/g)];
  const nums = matches.map(m => {
    const n = parseFloat(m[1].replace(/,/g, ''));
    return /[Kk]/.test(m[0].slice(-1)) ? n * 1000 : n;
  }).filter(n => n >= 10_000); // filter noise like "3 months"
  return nums.length ? Math.max(...nums) : null;
}

function validateRole(role) {
  const failures = [];
  const co = (role.company || '').toLowerCase();

  if (EXCLUDE_COMPANIES.some(ex => co.includes(ex))) {
    failures.push(`EXCLUDED: ${role.company}`);
  }

  if (role.score === null || role.score === undefined) {
    failures.push(`NO SCORE recorded`);
  } else if (role.score < MIN_SCORE) {
    failures.push(`SCORE ${role.score}/10 below floor (${MIN_SCORE})`);
  }

  const salMax = parseSalaryMax(role.salary_text);
  if (salMax !== null) {
    const isHourly = /\/hr|per.?hour|hourly/i.test(role.salary_text);
    const floor = isHourly ? SALARY_FLOOR_HOURLY : SALARY_FLOOR_FTE;
    if (salMax < floor) {
      failures.push(`SALARY ${role.salary_text} below floor ($${floor.toLocaleString()}${isHourly ? '/hr' : ''})`);
    }
  }

  return { canSubmit: failures.length === 0, failures };
}

// ─── Playwright helpers ────────────────────────────────────────────

async function fillIfVisible(page, selector, value, timeout = 2000) {
  try {
    const el = page.locator(selector).first();
    if (await el.isVisible({ timeout }).catch(() => false)) {
      await el.fill(String(value));
      return true;
    }
  } catch {}
  return false;
}

async function clickIfVisible(page, selector, timeout = 3000) {
  try {
    const el = page.locator(selector).first();
    if (await el.isVisible({ timeout }).catch(() => false)) {
      await el.click();
      return true;
    }
  } catch {}
  return false;
}

function ensureAuditDir() {
  const today = new Date().toISOString().slice(0, 10);
  const dir = join(AUDIT_ROOT, today);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Read the post-submit page text and decide the outcome. Rejections are
 * checked FIRST — Ashby's spam-flag banner contains the words "your
 * application", which the old loose regex misread as success (caught
 * 2026-06-12: Tilt + FurtherAI false positives).
 */
function readSubmitOutcome(text) {
  const neg = text.match(/couldn.t submit[^\n.]*|flagged as possible spam[^\n.]*|needs corrections[^\n.]*|missing entry for required[^\n.]*/i);
  if (neg) return { ok: false, negative: neg[0].trim().slice(0, 160) };
  const ok = /thank you|application (has been )?(received|submitted|complete)|we.ve received your|successfully (submitted|applied)/i.test(text);
  return { ok, negative: null };
}

/**
 * Attach a file to the upload input whose surrounding text matches labelRegex
 * (e.g. /resume|cv\b/i vs /cover/i). Returns true if attached.
 */
async function attachFileByLabel(page, labelRegex, filePath) {
  const inputs = page.locator('input[type="file"]');
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    const input = inputs.nth(i);
    const context = await input.evaluate((el) => {
      let node = el.parentElement;
      let text = '';
      for (let d = 0; d < 4 && node; d++) {
        text = (node.innerText || '').slice(0, 300);
        if (/resume|cover|cv\b/i.test(text)) break;
        node = node.parentElement;
      }
      return text;
    }).catch(() => '');
    if (labelRegex.test(context)) {
      await input.setInputFiles(filePath);
      return true;
    }
  }
  return false;
}

/**
 * Fill empty text/textarea/select questions whose labels keyword-match a
 * canned answer from candidate.json (visa, salary, years-of-X, etc.).
 * Conservative: unmatched fields are left alone. Returns labels of required
 * fields still empty (these will block submit → captured in failure reason).
 */
async function fillKnownQuestions(page) {
  const answers = await loadAnswers();
  const fields = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('input[type="text"], input[type="number"], textarea, select').forEach((el) => {
      if (el.value && el.value.length > 0 && el.tagName !== 'SELECT') return;
      let label = '';
      if (el.id) label = document.querySelector(`label[for="${el.id}"]`)?.innerText?.trim() || '';
      if (!label) label = el.closest('label, .field, [class*="question" i], [class*="field" i]')?.innerText?.trim().slice(0, 200) || '';
      out.push({
        tag: el.tagName,
        type: el.type || null,
        id: el.id || null,
        label,
        value: el.value || '',
        required: el.required || el.getAttribute('aria-required') === 'true',
        options: el.tagName === 'SELECT' ? [...el.options].map(o => o.text).filter(Boolean) : null,
      });
    });
    return out;
  }).catch(() => []);

  const unfilled = [];
  for (const f of fields) {
    if (f.tag === 'SELECT' && f.value) continue;
    if (!f.id) {
      // No id → try filling by accessible label (catches fields like
      // "What is your current age?" that have a label but no usable id).
      if (f.label && !f.value) {
        const m = matchAnswer(f.label, answers);
        if (m) {
          const v = f.type === 'number' ? String(numericAnswer(m.value) ?? '') : String(m.value);
          if (v) { try { await page.getByLabel(f.label, { exact: false }).first().fill(v, { timeout: 2500 }); continue; } catch {} }
        }
      }
      if (f.required && !f.value) unfilled.push((f.label || '(unlabeled field)').slice(0, 80));
      continue;
    }
    const match = matchAnswer(f.label, answers);
    if (!match) { if (f.required && !f.value) unfilled.push(f.label.slice(0, 80)); continue; }
    const sel = `[id="${f.id}"]`;
    try {
      if (f.tag === 'SELECT') {
        const want = String(match.value).toLowerCase();
        const opt = (f.options || []).find(o =>
          want.startsWith(o.toLowerCase()) || o.toLowerCase() === want || (want.split(/[\s,]/)[0] && o.toLowerCase().includes(want.split(/[\s,]/)[0]))
        );
        if (opt) await page.selectOption(sel, { label: opt });
        else if (f.required) unfilled.push(f.label.slice(0, 80));
      } else if (f.type === 'number') {
        const n = numericAnswer(match.value);
        if (n !== null) await page.locator(sel).first().fill(String(n), { timeout: 3000 });
        else if (f.required) unfilled.push(f.label.slice(0, 80));
      } else {
        await page.locator(sel).first().fill(String(match.value), { timeout: 3000 });
      }
    } catch {
      if (f.required) unfilled.push(f.label.slice(0, 80));
    }
  }

  // Radio groups (yes/no questions: business hours, work auth, EEO, etc.)
  const radioGroups = await page.evaluate(() => {
    const groups = {};
    document.querySelectorAll('input[type="radio"]').forEach((r) => {
      const name = r.name || 'g';
      if (!groups[name]) {
        let glabel = '';
        const fs = r.closest('fieldset');
        if (fs) glabel = fs.querySelector('legend')?.innerText?.trim() || '';
        if (!glabel) glabel = r.closest('[class*="field" i], [class*="question" i]')?.innerText?.split('\n')[0]?.trim() || '';
        groups[name] = { label: glabel.slice(0, 220), options: [], checked: false };
      }
      let olabel = '';
      if (r.id) olabel = document.querySelector(`label[for="${r.id}"]`)?.innerText?.trim() || '';
      if (!olabel) olabel = r.closest('label')?.innerText?.trim() || r.value;
      groups[name].options.push({ value: r.value, label: olabel.slice(0, 60) });
      if (r.checked) groups[name].checked = true;
    });
    return Object.entries(groups).map(([name, g]) => ({ name, ...g }));
  }).catch(() => []);

  for (const g of radioGroups) {
    if (g.checked || !g.label) continue;
    const match = matchAnswer(g.label, answers);
    if (!match) { unfilled.push(g.label.slice(0, 80)); continue; }
    const want = String(match.value).toLowerCase();
    const yn = want.startsWith('yes') ? 'yes' : want.startsWith('no') ? 'no' : null;
    const target = g.options.find(o =>
      (yn && String(o.label).toLowerCase().startsWith(yn)) ||
      (!yn && String(o.label).toLowerCase().includes(want.split(/[\s,—-]/)[0]))
    );
    if (target) {
      await page.evaluate(({ name, value }) => {
        const el = [...document.querySelectorAll(`input[type="radio"][name="${name}"]`)].find(r => r.value === value);
        if (el) el.click();
      }, { name: g.name, value: target.value }).catch(() => {});
    } else {
      unfilled.push(g.label.slice(0, 80));
    }
  }

  // Custom (non-native) select widgets — Ashby/Radix/react-select comboboxes
  // (EEO Gender/Race/Veteran/Disability, location, etc.) that the native-select
  // and radio passes above cannot reach. Sav's EEO canned values are all
  // decline-style, so the "decline / prefer-not" option is the primary fallback.
  // NEVER press Enter (submits the form); Escape to dismiss is safe.
  const declineRe = /decline to (self.?identify|answer)|prefer not to (say|answer|disclose|self.?identify)|i (do not|don.?t) wish to (answer|self.?identify)|not a protected veteran|i am not a (protected )?veteran/i;
  const triggers = page.locator('[role="combobox"], [aria-haspopup="listbox"], button[aria-haspopup="menu"], [class*="select__control" i], [data-radix-select-trigger]');
  const tCount = await triggers.count().catch(() => 0);
  for (let i = 0; i < tCount; i++) {
    const trig = triggers.nth(i);
    if (!(await trig.isVisible({ timeout: 400 }).catch(() => false))) continue;
    const label = await trig.evaluate((el) => {
      const lb = el.getAttribute('aria-labelledby');
      if (lb) { const t = lb.split(/\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ').trim(); if (t) return t; }
      const al = el.getAttribute('aria-label'); if (al) return al.trim();
      const cont = el.closest('[class*="fieldEntry" i], [class*="field" i], [class*="question" i]');
      if (cont) { const lab = cont.querySelector('label, legend'); if (lab && lab.innerText) return lab.innerText.trim(); return (cont.innerText || '').split('\n')[0].trim(); }
      return '';
    }).catch(() => '');
    if (!label) continue;
    const match = matchAnswer(label, answers);
    if (!match) continue; // only touch fields we have a canned answer for
    const want = String(match.value);
    const firstTok = want.split(/[\s,]/)[0] || want;
    const curText = (await trig.innerText().catch(() => '')).trim();
    if (curText && firstTok && curText.toLowerCase().includes(firstTok.toLowerCase()) && !/select|choose|\.\.\./i.test(curText)) continue; // already set
    try {
      await trig.scrollIntoViewIfNeeded().catch(() => {});
      await trig.click();
      await page.waitForTimeout(400);
      await page.locator('[role="option"], [class*="select__option" i]').first().waitFor({ state: 'visible', timeout: 2500 }).catch(() => {});
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const valRe = new RegExp(want.split(/[\s,]/).slice(0, 2).filter(Boolean).map(esc).join('.*') || esc(want), 'i');
      let picked = false;
      const byVal = page.getByRole('option', { name: valRe }).first();
      if (await byVal.isVisible({ timeout: 800 }).catch(() => false)) { await byVal.click().catch(() => {}); picked = true; }
      if (!picked) {
        const byDecline = page.getByRole('option', { name: declineRe }).first();
        if (await byDecline.isVisible({ timeout: 600 }).catch(() => false)) { await byDecline.click().catch(() => {}); picked = true; }
      }
      if (!picked) { // react-select type-to-filter
        const inner = trig.locator('input').first();
        if (await inner.isVisible({ timeout: 300 }).catch(() => false)) {
          await inner.pressSequentially(firstTok, { delay: 50 });
          await page.waitForTimeout(700);
          const o2 = page.locator('[role="option"], [class*="select__option" i]').first();
          if (await o2.isVisible({ timeout: 800 }).catch(() => false)) { await o2.click().catch(() => {}); picked = true; }
        }
      }
      await page.keyboard.press('Escape').catch(() => {});
    } catch {}
  }

  return unfilled;
}

// ─── Platform submitters ───────────────────────────────────────────

async function submitGreenhouse(page, role, formData, resumePath, coverLetter, auditDir) {
  await page.goto(role.apply_url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const slug = `gh-${Date.now()}`;
  await page.screenshot({ path: join(auditDir, `${slug}-before.png`) });

  // Click Apply if on the listing (not already on the form)
  await clickIfVisible(page,
    'a:has-text("Apply for this job"), a:has-text("Apply Now"), a:has-text("Apply"), .btn-apply',
    4000
  );
  await page.waitForTimeout(800);
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

  // Fill fields
  await fillIfVisible(page, '#first_name', formData.first_name);
  await fillIfVisible(page, '#last_name', formData.last_name);
  await fillIfVisible(page, '#email', formData.email);
  await fillIfVisible(page, '#phone', formData.phone);
  await fillIfVisible(page, 'input[name*="linkedin" i], input[id*="linkedin" i]', formData.linkedin_url);
  await fillIfVisible(page, 'input[name*="website" i], input[id*="website" i]', formData.website);
  await fillIfVisible(page, 'input[name*="location" i], input[id*="location" i]', formData.location);

  // Resume + cover letter upload (label-aware; falls back to first input)
  const fileInputs = page.locator('input[type="file"]');
  const count = await fileInputs.count();
  const resumeAttached = await attachFileByLabel(page, /resume|cv\b/i, resumePath);
  if (!resumeAttached && count > 0) await fileInputs.first().setInputFiles(resumePath);
  if (coverLetter && coverLetter.docxPath) {
    const clAttached = await attachFileByLabel(page, /cover/i, coverLetter.docxPath);
    if (!clAttached) await fillIfVisible(page, 'textarea[name*="cover" i], textarea[id*="cover" i]', coverLetter.text, 1500);
  }
  await page.waitForTimeout(2000);

  // Canned answers for known questions (work auth, salary, years-of-X…)
  const unfilledRequired = await fillKnownQuestions(page);
  if (unfilledRequired.length) console.log(`[submit-ready]   note: required fields without canned answers: ${unfilledRequired.join(' | ')}`);

  // Submit
  const submitBtn = page.locator(
    'input[type="submit"][value*="Submit" i], button[type="submit"], button:has-text("Submit application")'
  ).first();
  if (!(await submitBtn.isVisible({ timeout: 4000 }).catch(() => false))) {
    await page.screenshot({ path: join(auditDir, `${slug}-no-submit-btn.png`) });
    return { ok: false, reason: 'Submit button not found on Greenhouse form' };
  }
  await submitBtn.click();
  // Past the irreversible click — a failure READING the outcome must become an
  // "unconfirmed" result (→ quarantine), never a throw (→ treated as not-submitted). (Hole #2.)
  let text = '';
  try {
    await page.waitForTimeout(4000);
    await page.screenshot({ path: join(auditDir, `${slug}-after.png`), fullPage: true });
    text = await page.evaluate(() => document.body.innerText);
  } catch (e) {
    return { ok: false, unconfirmed: true, reason: `clicked submit but could not read outcome: ${e.message}` };
  }
  const outcome = readSubmitOutcome(text);
  const why = outcome.ok ? 'Confirmed'
    : `${outcome.negative ? `Form rejected: ${outcome.negative}` : 'Could not confirm'} — screenshot saved${unfilledRequired.length ? `; required fields unanswered: ${unfilledRequired.join(' | ')}` : ''}`;
  return { ok: outcome.ok, unconfirmed: !outcome.ok && !outcome.negative, reason: why, snippet: text.slice(0, 300) };
}

async function submitAshby(page, role, formData, resumePath, coverLetter, auditDir) {
  await page.goto(role.apply_url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const slug = `ashby-${Date.now()}`;
  await page.screenshot({ path: join(auditDir, `${slug}-before.png`) });

  // Click Apply
  await clickIfVisible(page,
    'button:has-text("Apply"), a:has-text("Apply"), button:has-text("Apply for this position")',
    4000
  );
  await page.waitForTimeout(800);
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

  // Ashby uses first/last or combined name
  const hasFirstName = await fillIfVisible(page,
    'input[name="firstName"], input[placeholder*="First" i]', formData.first_name
  );
  if (hasFirstName) {
    await fillIfVisible(page, 'input[name="lastName"], input[placeholder*="Last" i]', formData.last_name);
  } else {
    await fillIfVisible(page, 'input[name="name"], input[placeholder*="name" i]', formData.full_name);
  }
  await fillIfVisible(page, 'input[name="email"], input[type="email"]', formData.email);
  await fillIfVisible(page, 'input[name="phone"], input[type="tel"]', formData.phone);
  await fillIfVisible(page, 'input[name*="linkedin" i]', formData.linkedin_url);

  // Ashby system fields (e.g. _systemfield_name) resist name-attr selectors —
  // fill by accessible label. Location fields are autocompletes: type, then
  // click the first suggestion (never press Enter — it would submit the form).
  const labelFills = [
    [/^name\b/i, formData.full_name],
    [/^(current )?(location|city)\b/i, formData.location],
  ];
  for (const [re, val] of labelFills) {
    try {
      const byLabel = page.getByLabel(re).first();
      if (await byLabel.isVisible({ timeout: 1200 }).catch(() => false)) {
        const cur = await byLabel.inputValue().catch(() => '');
        if (!cur) {
          await byLabel.fill(String(val));
          await page.waitForTimeout(900);
          const opt = page.locator('[role="option"], [class*="suggestion" i] li').first();
          if (await opt.isVisible({ timeout: 1200 }).catch(() => false)) await opt.click().catch(() => {});
        }
      }
    } catch {}
  }

  // Ashby location comboboxes ignore programmatic fill — they need real
  // keystrokes to surface suggestions, then a click on the first option.
  try {
    const locBox = page.locator('input[placeholder*="Start typing" i], input[aria-autocomplete="list"], [role="combobox"] input').first();
    if (await locBox.isVisible({ timeout: 1500 }).catch(() => false)) {
      const cur = await locBox.inputValue().catch(() => '');
      if (!cur) {
        await locBox.click();
        await locBox.pressSequentially(String(formData.location || 'New York, NY'), { delay: 60 });
        await page.waitForTimeout(1500);
        const opt = page.locator('[role="option"]').first();
        if (await opt.isVisible({ timeout: 2500 }).catch(() => false)) await opt.click().catch(() => {});
      }
    }
  } catch {}

  // Resume + cover letter upload (label-aware; falls back to first input)
  const fileInputs = page.locator('input[type="file"]');
  const resumeAttached = await attachFileByLabel(page, /resume|cv\b/i, resumePath);
  if (!resumeAttached && (await fileInputs.count()) > 0) await fileInputs.first().setInputFiles(resumePath);
  if (coverLetter && coverLetter.docxPath) {
    const clAttached = await attachFileByLabel(page, /cover/i, coverLetter.docxPath);
    if (!clAttached) await fillIfVisible(page, 'textarea[name*="cover" i], textarea[id*="cover" i]', coverLetter.text, 1500);
  }
  await page.waitForTimeout(2000);

  // Canned answers for known questions
  const unfilledRequired = await fillKnownQuestions(page);
  if (unfilledRequired.length) console.log(`[submit-ready]   note: required fields without canned answers: ${unfilledRequired.join(' | ')}`);

  // Submit
  const submitBtn = page.locator(
    'button[type="submit"], button:has-text("Submit application"), button:has-text("Submit")'
  ).first();
  if (!(await submitBtn.isVisible({ timeout: 4000 }).catch(() => false))) {
    await page.screenshot({ path: join(auditDir, `${slug}-no-submit-btn.png`) });
    return { ok: false, reason: 'Submit button not found on Ashby form' };
  }
  await submitBtn.click();

  // Poll up to 12s; stop early on either a confirmation or a rejection banner
  let text = '';
  let outcome = { ok: false, negative: null };
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(2000);
    text = await page.evaluate(() => document.body.innerText).catch(() => '');
    outcome = readSubmitOutcome(text);
    if (outcome.ok || outcome.negative) break;
  }

  await page.screenshot({ path: join(auditDir, `${slug}-after.png`), fullPage: true }).catch(() => {});
  const why = outcome.ok ? 'Confirmed'
    : `${outcome.negative ? `Form rejected: ${outcome.negative}` : 'Could not confirm'} — screenshot saved${unfilledRequired.length ? `; required fields unanswered: ${unfilledRequired.join(' | ')}` : ''}`;
  return { ok: outcome.ok, unconfirmed: !outcome.ok && !outcome.negative, reason: why, snippet: text.slice(0, 300) };
}

async function submitLever(page, role, formData, resumePath, coverLetter, auditDir) {
  await page.goto(role.apply_url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const slug = `lever-${Date.now()}`;
  await page.screenshot({ path: join(auditDir, `${slug}-before.png`) });

  // Click Apply if on the listing
  await clickIfVisible(page,
    'a.postings-btn-submit, a:has-text("Apply for this job"), a:has-text("Apply Now"), button:has-text("Apply")',
    4000
  );
  await page.waitForTimeout(800);
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

  // Fill fields
  await fillIfVisible(page, 'input[name="name"]', formData.full_name);
  await fillIfVisible(page, 'input[name="email"]', formData.email);
  await fillIfVisible(page, 'input[name="phone"]', formData.phone);
  await fillIfVisible(page, 'input[name="org"]', formData.current_company);
  await fillIfVisible(page, 'input[name*="linkedin" i], input[name*="urls[LinkedIn]"]', formData.linkedin_url);

  // Resume upload
  const fileInput = page.locator('input[type="file"][name="resume"], input[type="file"]').first();
  if (await fileInput.count() > 0) {
    await fileInput.setInputFiles(resumePath);
    await page.waitForTimeout(2000);
  }

  // Cover letter → Lever's "Additional information" box (no native CL upload)
  if (coverLetter && coverLetter.text) {
    await fillIfVisible(page, 'textarea[name="comments"], textarea[name*="additional" i]', coverLetter.text, 1500);
  }

  // Canned answers for known questions
  const unfilledRequired = await fillKnownQuestions(page);
  if (unfilledRequired.length) console.log(`[submit-ready]   note: required fields without canned answers: ${unfilledRequired.join(' | ')}`);

  // Submit
  const submitBtn = page.locator(
    'button[type="submit"], input[type="submit"]'
  ).first();
  if (!(await submitBtn.isVisible({ timeout: 4000 }).catch(() => false))) {
    await page.screenshot({ path: join(auditDir, `${slug}-no-submit-btn.png`) });
    return { ok: false, reason: 'Submit button not found on Lever form' };
  }
  await submitBtn.click();
  // Past the irreversible click — a failure READING the outcome must become an
  // "unconfirmed" result (→ quarantine), never a throw (→ treated as not-submitted). (Hole #2.)
  let text = '';
  try {
    await page.waitForTimeout(4000);
    await page.screenshot({ path: join(auditDir, `${slug}-after.png`), fullPage: true });
    text = await page.evaluate(() => document.body.innerText);
  } catch (e) {
    return { ok: false, unconfirmed: true, reason: `clicked submit but could not read outcome: ${e.message}` };
  }
  const outcome = readSubmitOutcome(text);
  const why = outcome.ok ? 'Confirmed'
    : `${outcome.negative ? `Form rejected: ${outcome.negative}` : 'Could not confirm'} — screenshot saved${unfilledRequired.length ? `; required fields unanswered: ${unfilledRequired.join(' | ')}` : ''}`;
  return { ok: outcome.ok, unconfirmed: !outcome.ok && !outcome.negative, reason: why, snippet: text.slice(0, 300) };
}

// ─── Briefing writer ───────────────────────────────────────────────

async function writeBriefing(summary) {
  const stamp = (summary.started_at || new Date().toISOString()).replace(/[:.]/g, '-');
  const logPath = join(LOG_DIR, `submit-ready-${stamp}.json`);
  const briefPath = join(BRIEF_DIR, `submit-ready-${stamp}.txt`);

  await writeFile(logPath, JSON.stringify(summary, null, 2));

  const applied = summary.applied || [];
  const manual = summary.manual_required || [];
  const skipped = summary.skipped || [];
  const dups = summary.duplicates || [];
  const failed = summary.failed || [];
  const errors = summary.errors || [];

  const lines = [
    `Submit-Ready Daemon${summary.dry_run ? ' [DRY RUN]' : ''}`,
    `Run: ${summary.started_at} → ${summary.finished_at || '(in progress)'}`,
    ...(summary.forced_dry_run
      ? ['⚠ FORCED DRY-RUN — this host is NOT the authorized submitter (.secrets/submitter.allow absent).',
         '  Materials were staged but NOTHING was submitted. The Mac Mini (marker holder) is the live submitter.']
      : []),
    '═══════════════════════════════════════',
    '',
    `APPLIED (${applied.length})`,
    ...(applied.length
      ? applied.map(r => `  ✓ ${r.title} @ ${r.company} [${r.score}/10] via ${r.platform}${r.cover_letter ? ` | CL: ${r.cover_letter}` : ''}${r.dry_run ? ' [DRY RUN]' : ''}`)
      : ['  (none)']),
    '',
    `MANUAL REQUIRED (${manual.length}) — left in queue in Notion, materials staged`,
    ...(manual.length
      ? manual.map(r => `  ! ${r.title} @ ${r.company} — ${r.reason || `${r.platform} requires manual submit`}${r.resume ? ` | resume: ${r.resume}` : ''}${r.cover_letter ? ` | CL: ${r.cover_letter}` : ''}\n      ${r.apply_url || ''}`)
      : ['  (none)']),
    '',
    `DUPLICATES BLOCKED (${dups.length}) — archived in Notion with reason`,
    ...(dups.length
      ? dups.map(r => `  ⊘ ${r.title} @ ${r.company} — ${r.reason}`)
      : ['  (none)']),
    '',
    `SKIPPED (${skipped.length})`,
    ...(skipped.length
      ? skipped.map(r => `  - ${r.title || '?'} @ ${r.company || '?'} — ${r.reason}`)
      : ['  (none)']),
    '',
    `FAILED (${failed.length}) — left as "Materials Ready" in Notion (will retry)`,
    ...(failed.length
      ? failed.map(r => `  x ${r.title} @ ${r.company} — ${r.result?.reason || 'unknown'}`)
      : ['  (none)']),
    '',
    `ERRORS (${errors.length})`,
    ...(errors.length ? errors.map(e => `  ! ${e.role || ''}: ${e.error}`) : ['  (none)']),
    '',
    `Log: ${logPath}`,
    'Notion: https://www.notion.so/8ce2a0e30ab34416bcfe81295f4e4991',
  ];

  await writeFile(briefPath, lines.join('\n'));
  console.log(`[submit-ready] Briefing → ${briefPath}`);
  return { logPath, briefPath };
}

// ─── Main ──────────────────────────────────────────────────────────

async function main() {
  // Ensure directories
  for (const dir of [LOG_DIR, AUDIT_ROOT, BRIEF_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  // Resume integrity guard — fail loud if a configured resume is missing/renamed
  // so we never silently upload the wrong (or no) file. Single source of truth.
  const rcheck = await verifyResumes();
  if (!rcheck.ok) {
    console.warn(`[submit-ready] WARNING: missing resume file(s): ${rcheck.missing.join(', ')} — check config/candidate.json resume paths`);
  }

  // ─── Single-submitter guard (cross-machine) ───────────────────────
  // Fail-CLOSED: no marker on this host → force the whole run to dry-run.
  if (!existsSync(SUBMITTER_MARKER) && !DRY_RUN && !MOCK_RUN) {
    console.warn('\n' + '═'.repeat(66));
    console.warn('[submit-ready] SINGLE-SUBMITTER GUARD: this host is NOT the');
    console.warn(`  designated submitter (${SUBMITTER_MARKER} absent).`);
    console.warn('  Forcing DRY-RUN — will query + stage materials but NEVER submit.');
    console.warn('  Only the machine holding that marker (the Mac Mini) submits.');
    console.warn('═'.repeat(66) + '\n');
    DRY_RUN = true;
    forcedDryRun = true;
  }

  // ─── Single-instance lock (same-machine) ──────────────────────────
  // Only live runs contend; dry/mock never submit. A second concurrent run exits
  // cleanly rather than racing. Released on exit (and SIGINT/SIGTERM); a crashed
  // run's lock is reclaimed by the next run via the dead-PID / TTL check.
  if (!DRY_RUN && !MOCK_RUN) {
    if (!acquireInstanceLock()) {
      console.warn('[submit-ready] another submit-ready run holds the lock — exiting to avoid a concurrent double-submit.');
      process.exit(0);
    }
    console.log(`[submit-ready] instance lock acquired (pid ${process.pid}).`);
    process.on('exit', releaseInstanceLock);
    process.on('SIGINT', () => { releaseInstanceLock(); process.exit(130); });
    process.on('SIGTERM', () => { releaseInstanceLock(); process.exit(143); });
  }

  // Pre-flight: clear a stale browser-profile lock from a prior unclean exit.
  // A zombie Chromium silently locks .secrets/browser-profile → every Playwright
  // launch errors "profile already in use" and the whole run no-ops. Caught
  // 2026-06-15 (a leftover probe browser failed all 5 Ashby roles). Only the
  // automation profile is targeted (never the user's real Chrome).
  if (!DRY_RUN && !MOCK_RUN) {
    const profileDir = join(ROOT, '.secrets', 'browser-profile');
    try {
      execSync(`pkill -f "${profileDir}" 2>/dev/null; sleep 1`, { stdio: 'ignore' });
    } catch { /* pkill exits non-zero when nothing matched — fine */ }
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      const p = join(profileDir, f);
      if (existsSync(p)) { try { unlinkSync(p); } catch {} }
    }

    // Browser self-heal: if Playwright's Chromium binary is missing (the cache
    // gets purged — caught 2026-06-16, an overnight wipe errored every launch
    // with "Executable doesn't exist"), auto-reinstall so a scheduled run
    // recovers instead of silently submitting nothing.
    try {
      const exe = chromium.executablePath();
      if (!exe || !existsSync(exe)) {
        console.warn('[submit-ready] Chromium binary missing — reinstalling (npx playwright install chromium)…');
        execSync('npx playwright install chromium', { stdio: 'inherit', timeout: 300000 });
      }
    } catch (e) {
      console.warn(`[submit-ready] browser preflight: ${e.message} — attempting reinstall`);
      try { execSync('npx playwright install chromium', { stdio: 'inherit', timeout: 300000 }); } catch {}
    }
  }

  const started_at = new Date().toISOString();
  const summary = {
    started_at,
    dry_run: DRY_RUN,
    forced_dry_run: forcedDryRun, // host not authorized to submit → staged only, no submissions
    applied: [],
    manual_required: [],
    skipped: [],
    duplicates: [],
    failed: [],
    errors: [],
  };

  // Load Notion key (skip in mock mode)
  let notionKey = null;
  if (!MOCK_RUN) {
    try {
      notionKey = await loadNotionKey();
    } catch (err) {
      console.error(`[submit-ready] FATAL: ${err.message}`);
      process.exit(1);
    }
  }

  // Crash recovery: a leftover in-flight marker means a prior run died mid-submit.
  // That role MAY have gone through → quarantine to Needs Review (never blind-resubmit).
  // Runs BEFORE the queue query so the quarantined row drops out of the submit queue.
  if (!DRY_RUN && !MOCK_RUN && notionKey) {
    const inflight = readInflight();
    if (inflight?.page_id) {
      console.warn(`[submit-ready] crash recovery: "${inflight.label || inflight.page_id}" was mid-submit when a prior run ended — quarantining to Needs Review (verify before retry).`);
      try {
        await setNotionStatus(inflight.page_id, notionKey, 'Needs Review', `Interrupted mid-submit ${inflight.at} — a prior run ended after the submit click; verify whether it went through before any retry.`);
        recordAppliedPageId(inflight.page_id); // also block via the local ledger
        clearInflight();
      } catch (e) {
        console.error(`[submit-ready]   recovery quarantine failed (marker kept for next run): ${e.message}`);
      }
    }
  }

  // Query Notion (or use mock data)
  let pages;
  if (MOCK_RUN) {
    console.log('[submit-ready] MOCK MODE — using synthetic Notion pages');
    pages = MOCK_PAGES;
  } else try {
    pages = await querySubmitQueue(notionKey);
    console.log(`[submit-ready] Notion query: ${pages.length} page(s) in submit queue (${SUBMIT_STATUSES.join(' + ')})`);
  } catch (err) {
    console.error(`[submit-ready] FATAL Notion query: ${err.message}`);
    summary.errors.push({ role: 'notion-query', error: err.message });
    summary.finished_at = new Date().toISOString();
    await writeBriefing(summary);
    process.exit(1);
  }

  if (pages.length === 0) {
    console.log('[submit-ready] Nothing to do.');
    summary.finished_at = new Date().toISOString();
    await writeBriefing(summary);
    process.exit(0);
  }

  const formData = await buildFormData();
  const auditDir = ensureAuditDir();
  let submissionCount = 0;

  // Dedup state: roles already Applied in Notion + roles seen earlier in this queue
  let appliedKeys = new Map();
  if (!MOCK_RUN) {
    try {
      appliedKeys = await queryAppliedKeys(notionKey);
      console.log(`[submit-ready] Dedup cache: ${appliedKeys.size} prior/in-flight roles loaded`);
    } catch (err) {
      // A blind dedup cache means every role looks un-applied → mass double-submit.
      // For a LIVE run this is FATAL — abort rather than submit blind. (Audit 2026-06-16.)
      if (!DRY_RUN) {
        console.error(`[submit-ready] FATAL: dedup cache load failed on a live run — aborting to avoid double-submits: ${err.message}`);
        summary.errors.push({ role: 'dedup-cache', error: `aborted live run — dedup unavailable: ${err.message}` });
        summary.finished_at = new Date().toISOString();
        await writeBriefing(summary);
        process.exit(1);
      }
      console.warn(`[submit-ready] WARN (dry-run): dedup cache unavailable: ${err.message}`);
    }
  }
  const queueKeys = new Map();

  // Records a CONFIRMED submit so it can NEVER be re-sent — even if the Notion write
  // fails. In-memory + local ledger FIRST (cannot fail), then Notion; a Notion failure
  // quarantines to "Needs Review" (never back to a re-submittable state), and if even
  // that fails the in-flight marker is left for next-run recovery. (Impl-review hole #1.)
  const recordApplied = async (r, k, uk, meta, lbl) => {
    appliedKeys.set(k, `${r.title} @ ${r.company}`);
    if (uk) appliedKeys.set(uk, `${r.title} @ ${r.company}`);
    recordAppliedPageId(r.page_id);
    if (MOCK_RUN || !notionKey) { clearInflight(); return; }
    try { await setNotionApplied(r.page_id, notionKey, meta); clearInflight(); }
    catch (e) {
      console.error(`[submit-ready]   ⚠ APPLIED but Notion write failed: ${e.message} — quarantining (will NOT resubmit).`);
      try {
        await setNotionStatus(r.page_id, notionKey, 'Needs Review', `APPLIED ${new Date().toISOString().split('T')[0]} but Notion write failed — DO NOT resubmit; verify + mark Applied: ${e.message}`, r.fit_reason);
        clearInflight();
      } catch (e2) {
        summary.errors.push({ role: lbl, error: `applied-but-unrecorded (VERIFY MANUALLY): ${e.message}` });
      }
    }
  };
  // Quarantines an AMBIGUOUS submit to "Needs Review" so it never auto-resubmits.
  const quarantineRole = async (r, note, lbl) => {
    if (MOCK_RUN || !notionKey) { clearInflight(); return; }
    try { await setNotionStatus(r.page_id, notionKey, 'Needs Review', note, r.fit_reason); clearInflight(); }
    catch (e) { summary.errors.push({ role: lbl, error: `quarantine failed (left in-flight for next-run recovery): ${e.message}` }); }
  };

  for (const page of pages) {
    if (submissionCount >= MAX_SUBMISSIONS) {
      console.log(`[submit-ready] Batch cap ${MAX_SUBMISSIONS} reached.`);
      break;
    }

    const role = extractPageFields(page);
    const label = `${role.title || '?'} @ ${role.company || '?'}`;
    console.log(`\n[submit-ready] → ${label} (score: ${role.score})`);

    // Safety
    const { canSubmit, failures } = validateRole(role);
    if (!canSubmit) {
      console.log(`[submit-ready]   SKIP: ${failures.join('; ')}`);
      summary.skipped.push({ ...role, reason: failures.join('; ') });
      continue;
    }

    // Dedup — never send a duplicate application (title key + apply-URL key)
    const key = dedupKey(role.company, role.title);
    const uKey = urlKey(role.apply_url);
    const priorApplied = appliedKeys.get(key) || (uKey && appliedKeys.get(uKey));
    if (priorApplied) {
      console.log(`[submit-ready]   DUPLICATE BLOCKED: already applied — ${priorApplied}`);
      summary.duplicates.push({ ...role, reason: `Already applied: ${priorApplied}` });
      if (!MOCK_RUN && !DRY_RUN && notionKey) {
        await setNotionArchived(role.page_id, notionKey, `Duplicate of applied role — ${priorApplied}`, role.fit_reason)
          .catch(e => summary.errors.push({ role: label, error: `archive failed: ${e.message}` }));
      }
      continue;
    }
    const priorQueued = queueKeys.get(key) || (uKey && queueKeys.get(uKey));
    if (priorQueued) {
      console.log(`[submit-ready]   DUPLICATE BLOCKED: same role earlier in queue — kept ${priorQueued}`);
      summary.duplicates.push({ ...role, reason: `Duplicate queue row; kept ${priorQueued}` });
      if (!MOCK_RUN && !DRY_RUN && notionKey) {
        await setNotionArchived(role.page_id, notionKey, `Duplicate queue row — kept ${priorQueued}`, role.fit_reason)
          .catch(e => summary.errors.push({ role: label, error: `archive failed: ${e.message}` }));
      }
      continue;
    }
    queueKeys.set(key, `${role.title} @ ${role.company} [${role.status}]`);
    if (uKey) queueKeys.set(uKey, `${role.title} @ ${role.company} [${role.status}]`);

    // Live re-check backstop — confirm STILL eligible immediately before any
    // irreversible submit (catches a role another process applied to mid-run,
    // which the start-of-run snapshot can't see). Read-only; skip-on-uncertainty.
    if (!DRY_RUN && !MOCK_RUN && notionKey) {
      const re = await stillEligible(role.page_id, notionKey);
      if (!re.eligible) {
        console.log(`[submit-ready]   SKIP (live re-check): ${re.status}`);
        summary.duplicates.push({ ...role, reason: `Live re-check: ${re.status}` });
        continue;
      }
    }

    // Platform
    const platform = detectPlatform(role.apply_url);
    if (PLATFORM_FILTER && platform !== PLATFORM_FILTER) {
      console.log(`[submit-ready]   SKIP: platform=${platform} (filter=${PLATFORM_FILTER})`);
      summary.skipped.push({ ...role, reason: `platform filter: wanted ${PLATFORM_FILTER}, got ${platform}` });
      continue;
    }

    // LinkedIn — submit via Easy Apply bot (persistent logged-in profile)
    if (platform === 'linkedin') {
      const idMatch = role.apply_url.match(/\/jobs\/view\/(?:[^\s?#]*?)(\d{8,12})/) || role.apply_url.match(/currentJobId=(\d{8,12})/);
      const jobId = idMatch ? idMatch[1] : null;
      if (DRY_RUN) {
        console.log(`[submit-ready]   DRY RUN: would Easy Apply via LinkedIn (${jobId || role.apply_url})`);
        summary.applied.push({ ...role, platform, resume: 'LinkedIn default profile', cover_letter: 'N/A — Easy Apply', dry_run: true });
        continue;
      }
      try {
        console.log(`[submit-ready]   Easy Apply: ${jobId || role.apply_url}`);
        setInflight(role.page_id, label);
        const res = await applyTo(jobId, jobId ? {} : { url: role.apply_url });
        if (res.status === 'applied' || (res.status === 'skipped' && /already submitted/i.test(res.reason || ''))) {
          if (res.status === 'applied') submissionCount++;
          await recordApplied(role, key, uKey, { resume: 'LinkedIn default profile (v3)', coverLetter: 'N/A — Easy Apply', platform: 'linkedin', companyUrl: urlOrigin(role.apply_url), applyUrl: role.apply_url }, label);
          console.log(`[submit-ready]   ✓ ${res.status === 'applied' ? 'APPLIED via Easy Apply' : 'ALREADY SUBMITTED on LinkedIn — status synced'}`);
          summary.applied.push({ ...role, platform, resume: 'LinkedIn default profile', cover_letter: 'N/A — Easy Apply', result: res });
        } else if (res.status === 'saved_in_progress' || res.status === 'materials_ready') {
          clearInflight();
          const qs = (res.unanswered_questions || []).map(q => q.label).filter(Boolean).join(' | ');
          console.log(`[submit-ready]   ! NEEDS HUMAN: ${res.reason || qs}`);
          summary.manual_required.push({ ...role, platform, reason: res.reason || `Easy Apply saved in progress — unanswered: ${qs}` });
        } else if (res.status === 'skipped') {
          clearInflight();
          console.log(`[submit-ready]   SKIP: ${res.reason}`);
          summary.skipped.push({ ...role, platform, reason: res.reason });
        } else {
          clearInflight();
          console.log(`[submit-ready]   ✗ FAILED: ${res.reason}`);
          summary.failed.push({ ...role, platform, result: res });
        }
      } catch (err) {
        clearInflight();
        console.error(`[submit-ready]   ERROR: ${err.message}`);
        summary.errors.push({ role: label, error: err.message });
      }
      continue;
    }

    // No URL or unknown platform with no classifier
    if (!role.apply_url || platform === 'unknown') {
      console.log(`[submit-ready]   SKIP: no apply URL or unrecognized platform`);
      summary.skipped.push({ ...role, platform: platform || 'unknown', reason: 'No apply URL or unrecognized platform' });
      continue;
    }

    // Dice — introspection-driven adapter, NOT yet in AUTONOMOUS_PLATFORMS.
    // Gated behind DICE_LIVE=1 (+ a captured Dice login) until its selectors are
    // live-verified under supervision; otherwise stage materials → MANUAL.
    if (platform === 'dice') {
      const resumeForRole = await selectResume(role.company, role.title);
      let cl = null;
      try { cl = await ensureCoverLetter(role); } catch (err) { console.warn(`[submit-ready]   cover letter gen failed: ${err.message}`); }
      if (process.env.DICE_LIVE === '1' && !DRY_RUN) {
        try {
          console.log(`[submit-ready]   Dice adapter (live-verify): ${role.apply_url}`);
          setInflight(role.page_id, label);
          const res = await applyToDice(role, { resumePath: resumeForRole, coverLetter: cl, formData, dryRun: false });
          if (res.ok || res.status === 'applied') {
            submissionCount++;
            await recordApplied(role, key, uKey, { resume: resumeForRole.split('/').pop(), coverLetter: cl ? cl.docxPath.split('/').pop() : '(none)', platform: 'dice', companyUrl: urlOrigin(role.apply_url), applyUrl: role.apply_url }, label);
            console.log(`[submit-ready]   ✓ APPLIED via Dice`);
            summary.applied.push({ ...role, platform, resume: resumeForRole.split('/').pop(), cover_letter: cl ? cl.docxPath.split('/').pop() : null, result: res });
          } else if (res.status === 'redirect' && res.url) {
            clearInflight();
            console.log(`[submit-ready]   Dice → external redirect (${res.platform}); routing MANUAL`);
            summary.manual_required.push({ ...role, platform: res.platform || 'redirect', reason: `Dice redirected to ${res.platform || 'external ATS'}: ${res.url}`, resume: resumeForRole.split('/').pop(), cover_letter: cl ? cl.docxPath.split('/').pop() : null });
          } else if (res.unconfirmed) {
            // Submit clicked but outcome unconfirmed — quarantine, never auto-resubmit. (Hole #4.)
            console.log(`[submit-ready]   ⚠ Dice UNCONFIRMED → Needs Review (will NOT auto-retry): ${res.reason}`);
            await quarantineRole(role, `Dice submit unconfirmed ${new Date().toISOString().split('T')[0]} — verify before any retry: ${res.reason}`, label);
            summary.failed.push({ ...role, platform, result: res, quarantined: true });
          } else {
            // Pre-submit failure (never clicked) — safe to retry. Clear marker.
            clearInflight();
            console.log(`[submit-ready]   ✗ Dice failed: ${res.reason}`);
            summary.failed.push({ ...role, platform, result: res });
          }
        } catch (err) {
          clearInflight();
          console.error(`[submit-ready]   Dice ERROR: ${err.message}`);
          summary.errors.push({ role: label, error: err.message });
        }
      } else {
        console.log(`[submit-ready]   MANUAL: Dice (adapter built; set DICE_LIVE=1 + Dice login to enable)`);
        summary.manual_required.push({ ...role, platform, reason: 'Dice — adapter pending live-verify (run with DICE_LIVE=1 after capture-login dice)', resume: resumeForRole.split('/').pop(), cover_letter: cl ? cl.docxPath.split('/').pop() : null });
      }
      continue;
    }

    // Tier 3 / custom ATS — manual submission, but stage materials so the
    // manual pass is copy-paste fast (routed resume + customized cover letter).
    if (MANUAL_PLATFORMS.has(platform) || !AUTONOMOUS_PLATFORMS.has(platform)) {
      let cl = null;
      try { cl = await ensureCoverLetter(role); } catch (err) { console.warn(`[submit-ready]   cover letter gen failed: ${err.message}`); }
      const resumeForRole = await selectResume(role.company, role.title);
      console.log(`[submit-ready]   MANUAL: ${platform} requires manual submission (materials staged)`);
      summary.manual_required.push({
        ...role, platform,
        reason: MANUAL_PLATFORMS.has(platform) ? `${platform} requires manual submit` : 'custom ATS',
        resume: resumeForRole.split('/').pop(),
        cover_letter: cl ? cl.docxPath.split('/').pop() : null,
      });
      continue;
    }

    // Resume + customized cover letter
    const resumePath = await selectResume(role.company, role.title);
    let coverLetter = null;
    try { coverLetter = await ensureCoverLetter(role); } catch (err) { console.warn(`[submit-ready]   cover letter gen failed: ${err.message}`); }
    console.log(`[submit-ready]   resume: ${resumePath.split('/').pop()} | cover letter: ${coverLetter ? coverLetter.docxPath.split('/').pop() : '(none)'}`);
    console.log(`[submit-ready]   platform: ${platform} | ${role.apply_url}`);

    // Dry-run gate
    if (DRY_RUN) {
      console.log(`[submit-ready]   DRY RUN: would submit via ${platform}`);
      summary.applied.push({ ...role, platform, resume: resumePath.split('/').pop(), cover_letter: coverLetter ? coverLetter.docxPath.split('/').pop() : null, dry_run: true });
      continue;
    }

    // Live Playwright submission — uses the persistent browser profile
    // (real fingerprint + cookies). Fresh headless chromium gets spam-flagged
    // by Ashby's bot detection (proven 2026-06-12 on Tilt/FurtherAI/Cohere).
    let browser;
    try {
      browser = await chromium.launchPersistentContext(
        join(ROOT, '.secrets', 'browser-profile'),
        { headless: HEADLESS, viewport: { width: 1280, height: 900 } }
      );
      const pg = await browser.newPage();

      setInflight(role.page_id, label); // crash-safety: cleared once a terminal state is recorded
      let result;
      if (platform === 'greenhouse') result = await submitGreenhouse(pg, role, formData, resumePath, coverLetter, auditDir);
      else if (platform === 'ashby')   result = await submitAshby(pg, role, formData, resumePath, coverLetter, auditDir);
      else if (platform === 'lever')   result = await submitLever(pg, role, formData, resumePath, coverLetter, auditDir);
      else result = { ok: false, reason: `No submitter for platform: ${platform}` };

      if (result.ok) {
        submissionCount++;
        await recordApplied(role, key, uKey, { resume: resumePath.split('/').pop(), coverLetter: coverLetter ? coverLetter.docxPath.split('/').pop() : '(none)', platform, companyUrl: urlOrigin(role.apply_url), applyUrl: role.apply_url }, label);
        console.log(`[submit-ready]   ✓ APPLIED${MOCK_RUN ? ' [MOCK — Notion NOT updated]' : ''}`);
        summary.applied.push({ ...role, platform, resume: resumePath.split('/').pop(), cover_letter: coverLetter ? coverLetter.docxPath.split('/').pop() : null, result });
      } else if (result.unconfirmed) {
        // AMBIGUOUS outcome — the submit MAY have gone through. Quarantine so it is
        // NEVER auto-resubmitted (that would double-apply). Human verifies. (Audit 2026-06-16.)
        console.log(`[submit-ready]   ⚠ UNCONFIRMED → Needs Review (will NOT auto-retry): ${result.reason}`);
        await quarantineRole(role, `Submit unconfirmed ${new Date().toISOString().split('T')[0]} — verify before any retry: ${result.reason}`, label);
        summary.failed.push({ ...role, platform, result, quarantined: true });
      } else {
        // True rejection (form bounced) — did NOT submit; safe to retry. Clear marker.
        clearInflight();
        console.log(`[submit-ready]   ✗ FAILED: ${result.reason}`);
        summary.failed.push({ ...role, platform, result });
      }
    } catch (err) {
      // Pre-click / launch errors (post-click read failures are returned as
      // unconfirmed by the submitters, NOT thrown) → did-not-submit; clear marker.
      clearInflight();
      console.error(`[submit-ready]   ERROR: ${err.message}`);
      summary.errors.push({ role: label, error: err.message });
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  summary.finished_at = new Date().toISOString();
  await writeBriefing(summary);

  const a = summary.applied.length;
  const m = summary.manual_required.length;
  const s = summary.skipped.length;
  const f = summary.failed.length;
  console.log(`\n[submit-ready] Done: ${a} applied, ${m} manual, ${s} skipped, ${f} failed`);
  process.exit(0);
}

main().catch(err => {
  console.error('[submit-ready] Unhandled:', err);
  process.exit(1);
});
