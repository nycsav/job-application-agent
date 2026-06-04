#!/usr/bin/env node
/**
 * Briefing — formats the runOnce() summary into an email body and creates a
 * Gmail draft via the Gmail API (using the OAuth flow in lib/gmail-auth.mjs).
 *
 * Usage:
 *   import { sendBriefing } from './briefing.mjs';
 *   await sendBriefing(summary);
 */

import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname2 = dirname(fileURLToPath(import.meta.url));
const BRIEF_DIR = join(__dirname2, '..', 'output', 'briefings');

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1Wd0x_0fEAyScgMKB9neneuMIo3Sgln-CMytWMF8m6eI/edit';
const BRIEFING_TO = 'sav@ensopartners.co';

function fmtRole(r) {
  const url = r.url || `https://www.linkedin.com/jobs/view/${r.job_id}/`;
  return `   ${r.title || '(unknown)'} @ ${r.company || '(unknown)'}  —  ${url}`;
}

function fmtUnanswered(qs) {
  if (!qs?.length) return '';
  return qs.map((q) => `      • "${q.label}"`).join('\n');
}

export function formatBriefingBody(summary) {
  const applied = summary.processed.filter((p) => p.status === 'applied');
  const saved = summary.processed.filter((p) => p.status === 'saved_in_progress');
  const materials = summary.processed.filter((p) => p.status === 'skipped' && /not Easy Apply|off LinkedIn/i.test(p.reason || ''));
  const skipped = summary.processed.filter((p) => p.status === 'skipped' && !materials.includes(p));
  const failed = summary.processed.filter((p) => p.status === 'failed');

  return `Daemon run: ${summary.started_at} → ${summary.finished_at}
Scan window: ${summary.hours}h
Threads: ${summary.threads_found}  ·  Unique IDs: ${summary.unique_ids}
Duplicates blocked: ${summary.duplicates}
Confirmations archived: ${summary.confirmations_archived || 0}

SUMMARY
- Easy Apply auto-submitted:   ${summary.applied}
- Saved in-progress:           ${summary.saved_in_progress}
- Materials Ready (manual):    ${summary.materials_ready}
- Skipped (filtered out):      ${summary.skipped}
- Failed:                      ${summary.failed}

APPLIED THIS RUN
${applied.length ? applied.map(fmtRole).join('\n') : '   (none)'}

SAVED IN-PROGRESS (open-text Q's blocked submit — finish manually)
${saved.length ? saved.map((r) => `${fmtRole(r)}\n${fmtUnanswered(r.unanswered_questions)}`).join('\n') : '   (none)'}

MATERIALS READY (no Easy Apply, manual submit needed)
${materials.length ? materials.map(fmtRole).join('\n') : '   (none)'}

SKIPPED (filtered: salary cap, location, already submitted, etc.)
${skipped.length ? skipped.map((r) => `${fmtRole(r)}\n      Reason: ${r.reason}`).join('\n') : '   (none)'}

FAILED (manual investigation required)
${failed.length ? failed.map((r) => `${fmtRole(r)}\n      Reason: ${r.reason}`).join('\n') : '   (none)'}

ERRORS (non-fatal)
${summary.errors.length ? summary.errors.map((e) => `   ${e.id || ''} ${e.error}`).join('\n') : '   (none)'}

Sheet: ${SHEET_URL}
`;
}

function encodeRfc2822(to, subject, body) {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    '',
    body,
  ];
  const raw = lines.join('\r\n');
  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sendBriefing(summary, { send = false } = {}) {
  // Phase 1: write briefing to local file. Gmail draft creation can be wired up
  // later once OAuth scopes include gmail.compose. For now, Sav reads the file.
  if (!existsSync(BRIEF_DIR)) await mkdir(BRIEF_DIR, { recursive: true });

  const stamp = summary.started_at.replace(/[:.]/g, '-');
  const subject = `Job daemon: ${summary.started_at.slice(0, 10)} — ${summary.applied} applied, ${summary.saved_in_progress} saved, ${summary.materials_ready} materials`;
  const body = formatBriefingBody(summary);

  const path = join(BRIEF_DIR, `briefing-${stamp}.txt`);
  await writeFile(path, `${subject}\n${'='.repeat(subject.length)}\n\n${body}`);

  return { sent: false, draftId: null, briefing_path: path };
}

// CLI: pipe a summary JSON in
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFile } = await import('fs/promises');
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: node briefing.mjs <summary.json> [--send]');
    process.exit(1);
  }
  const summary = JSON.parse(await readFile(path, 'utf-8'));
  const send = process.argv.includes('--send');
  const result = await sendBriefing(summary, { send });
  console.log(JSON.stringify(result, null, 2));
}
