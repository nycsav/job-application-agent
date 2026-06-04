#!/usr/bin/env node
/**
 * Entry point — one full daemon cycle.
 *
 * Invoked by launchd (every 4h) and on-demand:
 *   node daemon/run-once.mjs [--hours 12] [--max-submissions 5] [--send-briefing]
 *
 * Exit codes:
 *   0 — clean run (any number of applied / skipped, no fatal errors)
 *   1 — fatal error during scan or briefing dispatch
 */

import { writeFile } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { runOnce } from './apply-runner.mjs';
import { sendBriefing } from './briefing.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, '..', '.logs');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) return true; // boolean flag
  return v;
}

(async () => {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

  // 2026-05-28: Widened default from 12h to 24h. 12h was missing prior-evening alerts —
  // NY Life Corporate VP, AI/Agentic Experience Strategy (NYC, score 8+) landed at 9:36 PM
  // and was missed by every daemon run in the following 17 hours. 24h ensures the 9 AM
  // launchd fire catches everything from the prior evening. Override via --hours <N> at CLI.
  const hours = Number(arg('hours', 24));
  const maxSubmissions = Number(arg('max-submissions', 5));
  const send = arg('send-briefing', false) === true;
  const dryRun = arg('dry-run', false) === true;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const summaryPath = join(LOG_DIR, `run-${stamp}.json`);

  let summary;
  try {
    summary = await runOnce({ hours, maxSubmissions, dryRun });
    await writeFile(summaryPath, JSON.stringify(summary, null, 2));
    console.log(`[run-once] summary written to ${summaryPath}`);
  } catch (err) {
    console.error('[run-once] FATAL during runOnce:', err);
    await writeFile(summaryPath, JSON.stringify({ fatal: err.message, stack: err.stack }, null, 2));
    process.exit(1);
  }

  try {
    const brief = await sendBriefing(summary, { send });
    console.log(`[run-once] briefing ${send ? 'sent' : 'drafted'}: ${brief.draftId || brief.messageId}`);
  } catch (err) {
    console.error('[run-once] briefing failed:', err.message);
    process.exit(1);
  }

  process.exit(0);
})();
