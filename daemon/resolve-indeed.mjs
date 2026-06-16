#!/usr/bin/env node
/**
 * Resolve Indeed URLs — for queue roles whose Job URL is empty OR points at an
 * Indeed redirect (to.indeed.com / *.indeed.com), resolve the *real* employer
 * apply URL so the next submit-ready run can route the role to the correct ATS
 * adapter (Greenhouse / Ashby / Lever) instead of hitting an Indeed wrapper.
 *
 * Two-step, MCP-out-of-host design
 * ────────────────────────────────
 * This script runs OUTSIDE an MCP host, so it cannot call the Indeed MCP
 * connector (server id 22cb0d22-c01c-4363-a48b-d25cd2384810, tools
 * get_job_details(job_id) / search_jobs(search, location, country_code))
 * directly. The flow is therefore split:
 *
 *   1. RESOLVE (this script): query Notion for roles with a missing/Indeed URL,
 *      then PATCH in any URLs a human/MCP step has staged in the mapping file
 *      .logs/indeed-resolved.json  →  { "<notionPageId>": "<realApplyUrl>" }.
 *      Each PATCH is logged. Roles still missing a mapping are printed as a
 *      "NEEDS RESOLUTION" worklist (title, company, current url, page id) so a
 *      human — or a separate step running inside an MCP host with the Indeed
 *      connector — can look up the employer URL via get_job_details/search_jobs
 *      and add it to the mapping file.
 *
 *   2. RE-RUN: after the mapping file is filled, run this script again; the new
 *      entries are PATCHed into Notion and disappear from the worklist.
 *
 * NO browser automation, NO submission, NO form filling — read Notion + a local
 * JSON mapping, write the Job URL property, log. Safe to run unattended.
 *
 * Mapping file (hand-provided / MCP-provided):
 *   .logs/indeed-resolved.json
 *   {
 *     "<notion-page-id>": "https://boards.greenhouse.io/acme/jobs/123",
 *     "<notion-page-id>": "https://jobs.ashbyhq.com/acme/abc-def"
 *   }
 *
 * Run:
 *   node daemon/resolve-indeed.mjs            # PATCH staged mappings + print worklist
 *   node daemon/resolve-indeed.mjs --dry-run  # query + report only, no Notion writes
 *   node daemon/resolve-indeed.mjs --limit 25 # cap roles examined (default 50)
 *
 * Auth:
 *   NOTION_API_KEY env var — or write key to .secrets/notion-token.txt
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const LOG_DIR = join(ROOT, '.logs');
const MAPPING_PATH = join(LOG_DIR, 'indeed-resolved.json');

const NOTION_DB_ID = '8ce2a0e3-0ab3-4416-bcfe-81295f4e4991';
const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// Indeed MCP connector — used by the separate in-host step, documented here for
// the human/MCP operator who fills the mapping file. NOT called from this script.
const INDEED_MCP_SERVER_ID = '22cb0d22-c01c-4363-a48b-d25cd2384810';

// Statuses that make a role part of the live submit queue.
const QUEUE_STATUSES = ['Approved', 'Materials Ready'];

// ─── CLI args ──────────────────────────────────────────────────────

function cliArg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) return true; // boolean flag
  return v;
}

const DRY_RUN = cliArg('dry-run', false) === true;
const LIMIT = Number(cliArg('limit', 50));

// ─── Notion REST client ─────────────────────────────────────────────

async function loadNotionKey() {
  if (process.env.NOTION_API_KEY) return process.env.NOTION_API_KEY;
  const tokenPath = join(ROOT, '.secrets', 'notion-token.txt');
  if (existsSync(tokenPath)) return (await readFile(tokenPath, 'utf-8')).trim();
  throw new Error(
    'Notion API key not found. Set NOTION_API_KEY env var or write key to .secrets/notion-token.txt'
  );
}

async function notionFetch(method, endpoint, body, key) {
  const res = await fetch(`${NOTION_API_BASE}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Notion ${method} ${endpoint} → ${res.status}: ${json.message || JSON.stringify(json).slice(0, 200)}`);
  }
  return json;
}

async function queryQueue(key) {
  const pages = [];
  let cursor;
  do {
    const body = {
      filter: { or: QUEUE_STATUSES.map(s => ({ property: 'Status', select: { equals: s } })) },
      sorts: [{ property: 'Fit Score', direction: 'descending' }],
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    };
    const r = await notionFetch('POST', `/databases/${NOTION_DB_ID}/query`, body, key);
    pages.push(...(r.results || []));
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return pages;
}

function extractRole(page) {
  const pr = page.properties || {};
  const t = (x) =>
    x?.title?.map(n => n.plain_text).join('') ||
    x?.rich_text?.map(n => n.plain_text).join('') ||
    '';
  return {
    page_id: page.id,
    title: String(t(pr['Job Title'])),
    company: String(t(pr['Company'])),
    score: pr['Fit Score']?.number ?? null,
    status: pr['Status']?.select?.name || '',
    url: pr['Job URL']?.url || '',
  };
}

// A role needs resolution when the Job URL is empty OR it points at Indeed
// (to.indeed.com redirect, or any indeed.com host).
function needsResolution(url) {
  if (!url || !url.trim()) return true;
  return /(^|\.|\/\/)(to\.)?indeed\.com/i.test(url) || /indeed\.com/i.test(url);
}

async function loadMapping() {
  if (!existsSync(MAPPING_PATH)) return {};
  try {
    const raw = await readFile(MAPPING_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(`[resolve-indeed] WARN: ${MAPPING_PATH} is not a {pageId: url} object — ignoring`);
      return {};
    }
    return parsed;
  } catch (err) {
    console.warn(`[resolve-indeed] WARN: could not parse ${MAPPING_PATH}: ${err.message}`);
    return {};
  }
}

function isHttpUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u.trim());
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  let key;
  try {
    key = await loadNotionKey();
  } catch (err) {
    console.error(`[resolve-indeed] FATAL: ${err.message}`);
    process.exit(1);
  }

  let pages;
  try {
    pages = await queryQueue(key);
  } catch (err) {
    console.error(`[resolve-indeed] FATAL Notion query: ${err.message}`);
    process.exit(1);
  }

  const roles = pages.map(extractRole).filter(r => needsResolution(r.url)).slice(0, LIMIT);
  console.log(`[resolve-indeed] ${roles.length} role(s) with missing/Indeed URL in queue (${QUEUE_STATUSES.join(' + ')})`);

  const mapping = await loadMapping();
  const mappingCount = Object.keys(mapping).length;
  console.log(`[resolve-indeed] Mapping file: ${existsSync(MAPPING_PATH) ? `${mappingCount} entr${mappingCount === 1 ? 'y' : 'ies'} in ${MAPPING_PATH}` : `${MAPPING_PATH} not present yet`}`);

  const patched = [];
  const skipped = [];
  const unresolved = [];
  const errors = [];

  for (const role of roles) {
    const label = `${role.title || '?'} @ ${role.company || '?'}`;
    const real = mapping[role.page_id];

    if (!real) {
      unresolved.push(role);
      continue;
    }
    if (!isHttpUrl(real)) {
      console.log(`[resolve-indeed]   SKIP ${label}: mapping value is not an http(s) URL (${String(real).slice(0, 80)})`);
      skipped.push({ ...role, resolved: real, reason: 'mapping value not an http(s) URL' });
      continue;
    }
    if (needsResolution(real)) {
      console.log(`[resolve-indeed]   SKIP ${label}: mapping value still points at Indeed (${real.slice(0, 80)})`);
      skipped.push({ ...role, resolved: real, reason: 'mapping value still an Indeed URL' });
      continue;
    }

    const cleanUrl = real.trim().slice(0, 1900);
    console.log(`[resolve-indeed]   ${DRY_RUN ? 'WOULD PATCH' : 'PATCH'} ${label}`);
    console.log(`[resolve-indeed]       ${role.url ? role.url.slice(0, 90) : '(empty)'}  →  ${cleanUrl.slice(0, 90)}`);
    if (DRY_RUN) {
      patched.push({ ...role, resolved: cleanUrl, dry_run: true });
      continue;
    }
    try {
      await notionFetch('PATCH', `/pages/${role.page_id}`, {
        properties: { 'Job URL': { url: cleanUrl } },
      }, key);
      patched.push({ ...role, resolved: cleanUrl });
    } catch (err) {
      console.log(`[resolve-indeed]   ERROR patching ${label}: ${err.message.split('\n')[0]}`);
      errors.push({ ...role, resolved: cleanUrl, error: err.message.split('\n')[0] });
    }
  }

  // Print the worklist of roles still needing a real URL so a human / MCP step
  // can fill .logs/indeed-resolved.json. Indeed MCP tools to use in that step:
  //   get_job_details(job_id)  /  search_jobs(search, location, country_code)
  //   on server ${INDEED_MCP_SERVER_ID}.
  if (unresolved.length) {
    console.log(`\n[resolve-indeed] NEEDS RESOLUTION (${unresolved.length}) — add "<page_id>": "<realApplyUrl>" to ${MAPPING_PATH}`);
    console.log(`[resolve-indeed] (look up the employer URL via Indeed MCP ${INDEED_MCP_SERVER_ID}: get_job_details / search_jobs)`);
    for (const r of unresolved) {
      console.log(`  • ${r.title} @ ${r.company}  [${r.score ?? '?'}/10, ${r.status}]`);
      console.log(`      current url: ${r.url ? r.url : '(empty)'}`);
      console.log(`      page id:     ${r.page_id}`);
    }
    // Emit a ready-to-edit mapping skeleton for the unresolved roles.
    const skeleton = {};
    for (const r of unresolved) skeleton[r.page_id] = '';
    console.log(`\n[resolve-indeed] mapping skeleton (merge into ${MAPPING_PATH}):`);
    console.log(JSON.stringify(skeleton, null, 2));
  } else if (roles.length) {
    console.log(`\n[resolve-indeed] No roles left needing resolution — all queue Indeed/empty URLs are mapped.`);
  }

  // Persist a run log alongside the other daemon logs.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = join(LOG_DIR, `resolve-indeed-${stamp}.json`);
  const summary = {
    ran_at: new Date().toISOString(),
    dry_run: DRY_RUN,
    mapping_path: MAPPING_PATH,
    indeed_mcp_server_id: INDEED_MCP_SERVER_ID,
    queue_statuses: QUEUE_STATUSES,
    counts: {
      examined: roles.length,
      patched: patched.length,
      skipped: skipped.length,
      unresolved: unresolved.length,
      errors: errors.length,
    },
    patched,
    skipped,
    unresolved,
    errors,
  };
  try {
    await writeFile(logPath, JSON.stringify(summary, null, 2));
    console.log(`\n[resolve-indeed] Log → ${logPath}`);
  } catch (err) {
    console.warn(`[resolve-indeed] WARN: could not write log: ${err.message}`);
  }

  console.log(
    `[resolve-indeed] Done${DRY_RUN ? ' [DRY RUN]' : ''}: ` +
    `${patched.length} patched, ${unresolved.length} need resolution, ${skipped.length} skipped, ${errors.length} errors`
  );
  process.exit(0);
}

main().catch(err => {
  console.error('[resolve-indeed] Unhandled:', err);
  process.exit(1);
});
