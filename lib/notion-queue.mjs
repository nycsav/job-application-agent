#!/usr/bin/env node
/**
 * Notion Queue — read the approved apply-queue from the Career Command Center
 * and write submission results back. This is the bridge that makes Notion
 * (not the legacy Google Sheet) the source of truth for the Submitter.
 *
 * Uses the official Notion API client so it can run from a plain Mac terminal
 * OR be driven by Claude Code. Requires a Notion integration token:
 *
 *   export NOTION_TOKEN=secret_xxx   # internal integration shared with the DB
 *
 * Career Command Center:
 *   database_id    = 8ce2a0e3-0ab3-4416-bcfe-81295f4e4991
 *   data_source_id = 931eceb1-d35d-46ca-9d4a-7fbfa48d3f99
 */

import { Client } from '@notionhq/client';

export const NOTION_DATABASE_ID = '8ce2a0e3-0ab3-4416-bcfe-81295f4e4991';
export const NOTION_DATA_SOURCE_ID = '931eceb1-d35d-46ca-9d4a-7fbfa48d3f99';

function client() {
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    throw new Error(
      'NOTION_TOKEN env var required. Create an internal Notion integration, ' +
      'share the Career Command Center DB with it, then: export NOTION_TOKEN=secret_xxx'
    );
  }
  return new Client({ auth: token });
}

/** Infer the ATS platform from a job/apply URL so we pick the right form strategy. */
export function inferPlatform(jobUrl = '') {
  const u = (jobUrl || '').toLowerCase();
  if (u.includes('greenhouse') || u.includes('grnh.se')) return 'greenhouse';
  if (u.includes('ashby')) return 'ashby';
  if (u.includes('lever.co') || u.includes('jobs.lever')) return 'lever';
  if (u.includes('workday') || u.includes('myworkdayjobs')) return 'workday';
  if (u.includes('google.com/about/careers') || u.includes('careers.google')) return 'google_careers';
  if (u.includes('linkedin.com')) return 'linkedin';
  return 'custom';
}

// ─── Property readers (defensive against missing fields) ────────────
const txt = (p) => (p?.rich_text?.[0]?.plain_text) ?? (p?.title?.[0]?.plain_text) ?? '';
const sel = (p) => p?.select?.name ?? '';
const num = (p) => (typeof p?.number === 'number' ? p.number : null);
const url = (p) => p?.url ?? '';

/**
 * Fetch roles from the Career Command Center at a given Status.
 * Default "Approved" = roles you've cleared at the human gate, ready to submit.
 * @returns {Promise<Array<{pageId,company,title,jobUrl,platform,score,location,resumeVersion,salary,source}>>}
 */
export async function getRolesByStatus(status = 'Approved') {
  const notion = client();
  const roles = [];
  let cursor;
  do {
    const resp = await notion.databases.query({
      database_id: NOTION_DATABASE_ID,
      start_cursor: cursor,
      filter: { property: 'Status', select: { equals: status } },
    });
    for (const page of resp.results) {
      const pr = page.properties || {};
      const jobUrl = url(pr['Job URL']);
      roles.push({
        pageId: page.id,
        company: txt(pr['Company']),
        title: txt(pr['Job Title']),
        jobUrl,
        platform: inferPlatform(jobUrl),
        score: num(pr['Fit Score']),
        location: txt(pr['Location']),
        resumeVersion: txt(pr['Resume Version']),
        salary: txt(pr['Salary Range']),
        source: sel(pr['Source']),
      });
    }
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return roles;
}

/** Convenience: the queue is anything Approved (post-gate). */
export const getApprovedRoles = () => getRolesByStatus('Approved');

/**
 * Write a confirmed submission back to Notion: Status → Applied + Applied Date.
 * Call this ONLY after a real, confirmed submit (never speculatively).
 */
export async function markApplied(pageId, { confirmation = '' } = {}) {
  const notion = client();
  const today = new Date().toISOString().slice(0, 10);
  const properties = {
    Status: { select: { name: 'Applied' } },
    'Applied Date': { date: { start: today } },
  };
  if (confirmation) {
    properties['Agent Trail'] = {
      rich_text: [{ text: { content: `Submitted ${today}. Confirmation: ${confirmation}` } }],
    };
  }
  await notion.pages.update({ page_id: pageId, properties });
  return { pageId, status: 'Applied', applied_date: today };
}

// ─── CLI: print the current Approved queue (read-only smoke test) ───
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const status = process.argv[2] || 'Approved';
  getRolesByStatus(status)
    .then((roles) => {
      console.log(`\nCareer Command Center — Status="${status}" (${roles.length} roles)\n`);
      for (const r of roles) {
        console.log(`  [${r.score ?? '?'}] ${r.company} — ${r.title}`);
        console.log(`        platform: ${r.platform} | resume: ${r.resumeVersion || 'default'} | ${r.jobUrl || 'no url'}`);
      }
      console.log('');
    })
    .catch((err) => { console.error('Error:', err.message); process.exit(1); });
}
