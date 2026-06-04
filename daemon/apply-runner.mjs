#!/usr/bin/env node
/**
 * Apply Runner — orchestrates one end-to-end pass.
 *
 *   1. Scan Gmail via Apps Script relay (broader 8-query set)
 *   2. Extract LinkedIn job IDs from threads
 *   3. For each ID: applyTo() via Playwright bot
 *   4. Write a Sheet row for every processed role (Applied / Materials Ready / Skipped)
 *   5. clean_confirmations on the inbox
 *   6. Return a structured summary for the briefing module
 *
 * Run as a one-shot:
 *   node daemon/apply-runner.mjs --hours 24 --max-submissions 5
 *
 * Or import:
 *   import { runOnce } from './apply-runner.mjs';
 *   const summary = await runOnce({ hours: 24, maxSubmissions: 5 });
 */

import { scanGmail, cleanConfirmations, appendRow, checkDuplicate, readRows, extractLinkedInIds } from './relay-client.mjs';
import { applyTo } from './easy-apply-bot.mjs';

const BROADER_QUERIES = [
  'from:jobalerts-noreply@linkedin.com',
  'from:linkedin.com subject:(alert OR jobs OR recommendation OR job)',
  'from:linkedin.com subject:(consulting OR consultant OR transformation OR strategy OR advisory)',
  'from:indeed.com subject:(AI OR strategy OR transformation OR consultant OR advisor OR director OR VP OR Head)',
  'from:(recruiter OR talent OR hiring) subject:(opportunity OR role OR position OR job)',
  'subject:(AI Consultant OR AI Strategy OR AI Transformation OR AI Advisor OR Senior AI OR Principal AI)',
  'subject:(Director Strategy OR VP Strategy OR Head Strategy OR Chief Strategy) AI',
  'from:(builtin.com OR dice.com OR ziprecruiter.com)',
];

function today() {
  return new Date().toISOString().slice(0, 10);
}

function nowHHmm() {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function scoreFromSignals(signals) {
  // Mirror SKILL.md rubric — degraded if JD body isn't accessible from a single page-load.
  // We score conservatively from header signals only; full JD scoring should happen
  // upstream in a separate module if needed.
  let s = 0;
  const t = (signals.title || '').toLowerCase();
  if (/\b(vp|chief|head|principal)\b/.test(t)) s += 3;
  else if (/sr\.?\s*director|senior director/.test(t)) s += 2;
  else if (/director|manager|lead/.test(t)) s += 1;
  // Skills — header alone can't see JD body; assume baseline 1 for AI titles
  if (/\bai|llm|ml|gen[\s-]?ai|agent|strateg|transform|consult/.test(t)) s += 1;
  // Industry — unknown without JD body
  s += 1;
  // Location
  if (/remote|hybrid|new york|nyc/i.test(signals.location || '')) s += 1;
  // Comp
  const cap = (signals.salary || '').match(/\$([\d.]+)\s*K/i);
  if (cap && Number(cap[1]) >= 200) s += 1;
  return s;
}

// 2026-05-28: Widened default from hours=12 to hours=24 (matches run-once.mjs default).
export async function runOnce({ hours = 24, maxSubmissions = 5, dryRun = false } = {}) {
  const summary = {
    started_at: new Date().toISOString(),
    hours,
    threads_found: 0,
    unique_ids: 0,
    processed: [],
    applied: 0,
    saved_in_progress: 0,
    materials_ready: 0,
    skipped: 0,
    failed: 0,
    duplicates: 0,
    errors: [],
  };

  // 1. Scan
  console.log(`[runner] scanning Gmail relay (${hours}h, ${BROADER_QUERIES.length} queries)…`);
  const scan = await scanGmail(hours, BROADER_QUERIES);
  summary.threads_found = scan.total_threads || 0;
  const { ids, threadsById } = extractLinkedInIds(scan);
  summary.unique_ids = ids.length;
  console.log(`[runner] scan: ${summary.threads_found} threads, ${summary.unique_ids} unique IDs`);

  // Build appliedSet — only block roles where the Sheet shows status='Applied' (with applied_date).
  // Previously the daemon called check_duplicate which blocked ANY company+title match — that wrongly
  // skipped Loftware ($138K-$220K), K2 ($175K-$250K), Fueled ($300K-$320K) on 2026-05-28 runs because
  // they were tracked as 'Materials Ready' from a prior scan but never actually submitted. Patched
  // 2026-05-28 per Sav's direction: re-attempts allowed unless explicitly Applied.
  const appliedSet = new Set();
  let appliedRowCount = 0;
  try {
    const rowsResp = await readRows();
    const rows = rowsResp.rows || [];
    for (const r of rows) {
      const status = (r.status || '').toLowerCase().trim();
      if (status !== 'applied') continue;
      const co = (r.company || '').toLowerCase().trim();
      const t = (r.job_title || '').toLowerCase().trim();
      if (co && t) {
        appliedSet.add(`${co}|${t}`);
        appliedRowCount++;
      }
    }
    console.log(`[runner] dedup cache: ${appliedRowCount} Applied rows loaded from Sheet`);
  } catch (err) {
    console.warn(`[runner] WARN: could not load Sheet for dedup cache — falling back to legacy check_duplicate. ${err.message}`);
  }
  summary.applied_rows_in_cache = appliedRowCount;

  let submissions = 0;

  // 2. Process each ID
  for (const id of ids) {
    if (submissions >= maxSubmissions) {
      summary.processed.push({ id, status: 'skipped', reason: 'submission cap reached' });
      summary.skipped++;
      continue;
    }

    let result;
    try {
      result = await applyTo(id, { dryRun });
    } catch (err) {
      summary.errors.push({ id, error: err.message });
      summary.failed++;
      continue;
    }

    // Dedup check against Sheet — Applied-only as of 2026-05-28.
    // If appliedSet was loaded successfully (size > 0 OR no error), use it. Otherwise fall back to relay check_duplicate.
    if (result.title && result.company) {
      const key = `${result.company.toLowerCase().trim()}|${result.title.toLowerCase().trim()}`;
      if (appliedSet.size > 0) {
        if (appliedSet.has(key)) {
          summary.duplicates++;
          summary.processed.push({ id, status: 'duplicate', reason: 'already Applied in Sheet', title: result.title, company: result.company });
          continue;
        }
        // else: not in appliedSet → re-attempt allowed even if previously tracked as Materials Ready / Tier 2
      } else {
        // Fallback: legacy check_duplicate (any-status match) only if appliedSet failed to load
        try {
          const dup = await checkDuplicate(result.company, result.title);
          if (dup.is_duplicate) {
            summary.duplicates++;
            summary.processed.push({ id, status: 'duplicate', reason: 'legacy any-status dedup (appliedSet empty)', title: result.title, company: result.company });
            continue;
          }
        } catch (err) {
          summary.errors.push({ id, error: `dedup check failed: ${err.message}` });
        }
      }
    }

    summary.processed.push(result);

    if (result.status === 'applied') {
      summary.applied++;
      submissions++;
    } else if (result.status === 'saved_in_progress') {
      summary.saved_in_progress++;
    } else if (result.status === 'materials_ready') {
      summary.materials_ready++;
    } else if (result.status === 'skipped') {
      summary.skipped++;
    } else if (result.status === 'failed') {
      summary.failed++;
    } else if (result.status === 'dry_run_qualifying') {
      // Would have submitted in a real run
      summary.skipped++;
    }

    // Write Sheet row (skipped roles get a TIER 2 tracking row too)
    // BUT NOT failed/dry_run — those should be retried on next run, not cached as done.
    const shouldWriteRow =
      !dryRun &&
      result.title &&
      result.company &&
      result.status !== 'failed' &&
      result.status !== 'dry_run_qualifying';
    if (shouldWriteRow) {
      const score = scoreFromSignals(result);
      const row = {
        priority: result.status === 'applied' ? 'TIER 1' : 'TIER 2',
        date_found: today(),
        fit_score: score,
        urgent: result.status === 'applied' ? 'Yes' : 'No',
        job_title: result.title,
        company: result.company,
        location: result.location || '',
        salary_range: result.salary || 'Not posted',
        fit_reason: `Header-only score ${score}/10. Daemon classification: ${result.status}.${result.reason ? ' Reason: ' + result.reason : ''}`,
        job_url: result.url || `https://www.linkedin.com/jobs/view/${id}/`,
        source: 'LinkedIn Alert (daemon)',
        portfolio_links: 'ensolabs.ai/work',
        resume_link: 'PDF: Sav_Banerjee_Resume_2026_v2.pdf',
        cover_letter_link: result.status === 'applied' ? 'N/A - Easy Apply' : 'Pending generation',
        form_url: result.url || `https://www.linkedin.com/jobs/view/${id}/`,
        status:
          result.status === 'applied' ? 'Applied' :
          result.status === 'saved_in_progress' ? 'Needs Manual Submit' :
          result.status === 'failed' ? 'Submit Failed' :
          'Materials Ready',
        applied_date: result.status === 'applied' ? `${today()} ${nowHHmm()}` : '',
        notes:
          result.status === 'saved_in_progress'
            ? `Saved in LinkedIn drafts. Open Qs: ${(result.unanswered_questions || []).map((q) => q.label).join(' | ')}`
            : `Daemon run ${today()} ${nowHHmm()}. ${result.reason || ''}`,
      };
      try {
        await appendRow(row);
        if (row.status === 'Materials Ready') summary.materials_ready++;
      } catch (err) {
        summary.errors.push({ id, error: `appendRow failed: ${err.message}` });
      }
    }
  }

  // 3. Clean confirmations
  if (!dryRun) {
    try {
      const clean = await cleanConfirmations(48);
      summary.confirmations_archived = clean.total_archived || 0;
    } catch (err) {
      summary.errors.push({ error: `clean_confirmations failed: ${err.message}` });
    }
  }

  summary.finished_at = new Date().toISOString();
  return summary;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a, i, arr) => {
      if (a.startsWith('--')) {
        const next = arr[i + 1];
        return [a.slice(2), next && !next.startsWith('--') ? next : true];
      }
      return [null, null];
    }).filter(([k]) => k)
  );
  const summary = await runOnce({
    hours: Number(args.hours || 12),
    maxSubmissions: Number(args['max-submissions'] || 5),
    dryRun: args['dry-run'] === true,
  });
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}
