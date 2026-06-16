#!/usr/bin/env node
/**
 * Easy Apply Bot — headless Playwright submitter for LinkedIn Easy Apply.
 *
 * Why this beats the Chrome MCP flow:
 *  - Playwright frameLocator() traverses the LinkedIn preload iframe natively;
 *    no coordinate guessing.
 *  - setInputFiles() handles resume + cover letter upload reliably.
 *  - waitForLoadState('networkidle') beats arbitrary sleeps.
 *  - Persistent storage state means LinkedIn login persists across runs.
 *
 * One-time setup (run interactively to capture LinkedIn cookies):
 *   node daemon/easy-apply-bot.mjs --login
 *   # browser opens; sign into linkedin.com manually; press Enter in terminal
 *
 * Submit a single role:
 *   node daemon/easy-apply-bot.mjs --apply 4417766658
 *
 * The bot returns a structured result:
 *   { ok: true, status: 'applied'|'saved_in_progress'|'skipped'|'failed',
 *     job_id, title, company, salary, location, easy_apply: bool,
 *     submitted_at: ISO, unanswered_questions: [], reason: string,
 *     audit: { before_screenshot, after_screenshot } }
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { loadAnswers, matchAnswer, numericAnswer } from './canned-answers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const STORAGE_STATE_PATH = join(REPO_ROOT, '.secrets', 'linkedin-state.json');
const AUDIT_ROOT = join(REPO_ROOT, '.audit');
// Resume default sourced from config/candidate.json (resume.default_path) so it
// stays in lock-step with the single source of truth (lib/resume-router.mjs) and
// never drifts. Per-role routing can later call resume-router selectResume().
const RESUME_DEFAULT = (() => {
  try {
    const c = JSON.parse(readFileSync(join(REPO_ROOT, 'config', 'candidate.json'), 'utf-8'));
    return join(REPO_ROOT, c.resume.default_path);
  } catch {
    return join(REPO_ROOT, 'materials', 'resumes', 'Sav_Banerjee_Resume_2026_v3.pdf');
  }
})();

const HARD_FILTERS = {
  // 2026-05-28: Added 'sia partners' + 'sia experience' — Sav is in direct recruiter conversation, do not auto-apply.
  excludedCompanies: ['perplexity', 'boi', 'board of innovation', 'sia partners', 'sia experience'],
  // Updated 2026-05-28: "United States" (LinkedIn's tag for remote-anywhere-in-US) now passes.
  // Previously the regex only accepted "remote", "hybrid", "new york", "nyc" — wrongly skipped Loftware ($138-220K), K2 ($175-250K), Fueled ($300-320K) on 2026-05-28 16:39 run.
  acceptedLocations: /remote|hybrid|new york|nyc|united states|remote.friendly/i,
  minSalaryCap: 200_000,
  // Lowered salary floor on 2026-05-28 — Sav OK'd anything $80+/hr (~$165K/yr) for contract pipeline.
  // Set minSalaryCap to 150_000 if you want to capture more contract roles; keeping 200K for FT for now.
};

function ensureAuditDir() {
  const today = new Date().toISOString().slice(0, 10);
  const dir = join(AUDIT_ROOT, today);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Login bootstrap ───────────────────────────────────────────

export async function login() {
  if (!existsSync(join(REPO_ROOT, '.secrets'))) mkdirSync(join(REPO_ROOT, '.secrets'));
  const browser = await chromium.launchPersistentContext(
    join(REPO_ROOT, '.secrets', 'browser-profile'),
    { headless: false, viewport: { width: 1280, height: 800 } }
  );
  const page = browser.pages()[0] || (await browser.newPage());
  await page.goto('https://www.linkedin.com/login');
  console.log('Sign in to LinkedIn in the browser window, then return here.');
  console.log('Press Ctrl+C when done — your session is auto-saved.');
  await new Promise(() => {}); // keep open
}

// ─── Helpers ────────────────────────────────────────────────────

async function makeContext() {
  const browser = await chromium.launchPersistentContext(
    join(REPO_ROOT, '.secrets', 'browser-profile'),
    { headless: process.env.HEADLESS !== 'false', viewport: { width: 1280, height: 900 } }
  );
  return browser;
}

function parseSalaryCap(text) {
  if (!text) return null;
  // Match "$202.4K/yr - $364.4K/yr" → 364400
  const matches = [...text.matchAll(/\$([\d.]+)\s*K/gi)];
  if (!matches.length) return null;
  const nums = matches.map((m) => Math.round(parseFloat(m[1]) * 1000));
  return Math.max(...nums);
}

function passesHardFilters({ company, location, salaryText }) {
  if (!company) return { ok: false, reason: 'missing company' };
  if (HARD_FILTERS.excludedCompanies.some((c) => company.toLowerCase().includes(c)))
    return { ok: false, reason: `excluded company: ${company}` };
  if (location && !HARD_FILTERS.acceptedLocations.test(location))
    return { ok: false, reason: `location not in NYC/Remote/Hybrid: ${location}` };
  const cap = parseSalaryCap(salaryText);
  if (cap !== null && cap < HARD_FILTERS.minSalaryCap)
    return { ok: false, reason: `salary cap $${cap.toLocaleString()} below floor` };
  return { ok: true };
}

// ─── Extract JD page signals ───────────────────────────────────

async function extractJobSignals(page) {
  const data = await page.evaluate(() => {
    const body = document.body.innerText;
    const titleEl = document.querySelector('h1');
    const companyEl = document.querySelector('.job-details-jobs-unified-top-card__company-name a, .topcard__org-name-link');
    // LinkedIn title format: "Job Title | Company | LinkedIn" or "Job Title at Company | LinkedIn"
    const docTitle = document.title.replace(' | LinkedIn', '').trim();
    let titleFromDoc = docTitle;
    let companyFromTitle = null;
    if (docTitle.includes(' | ')) {
      const parts = docTitle.split(' | ');
      titleFromDoc = parts[0].trim();
      companyFromTitle = parts[parts.length - 1].trim();
    } else if (/ at /i.test(docTitle)) {
      const m = docTitle.match(/^(.+?)\s+at\s+(.+)$/i);
      if (m) { titleFromDoc = m[1].trim(); companyFromTitle = m[2].trim(); }
    }
    return {
      title: (titleEl?.innerText || titleFromDoc).trim(),
      company: (companyEl?.innerText?.trim()) || companyFromTitle || null,
      isEasyApply: /easy apply/i.test(body),
      offLinkedIn: /responses managed off linkedin/i.test(body),
      submitted: /application submitted|applied \d/i.test(body),
      salary: (body.match(/\$[\d,]+\.?\d*\s*K?\/yr[^\n]*(?:\$?[\d,]+\.?\d*\s*K?)?/i) || [])[0] || null,
      location: (body.match(/Remote|Hybrid|New York[^\n]*|United States/i) || [])[0] || null,
    };
  });
  // Final fallback for company
  if (!data.company) {
    data.company = await page
      .locator('.job-details-jobs-unified-top-card__company-name, .topcard__org-name-link')
      .first()
      .innerText()
      .then(t => t?.trim() || null)
      .catch(() => null);
  }
  return data;
}

// ─── Easy Apply form walker ────────────────────────────────────

async function walkForm(page, modalLocator, jobId, answers) {
  const unanswered = [];
  let stepCount = 0;
  const MAX_STEPS = 8;

  while (stepCount < MAX_STEPS) {
    stepCount++;
    await page.waitForTimeout(800);

    // Dismiss "Save this application?" overlay if present
    const overlayCancel = modalLocator.locator('button:has-text("Discard"), [aria-label="Dismiss"]').first();
    if (await overlayCancel.isVisible({ timeout: 300 }).catch(() => false)) {
      // Leave the prior draft alone — Cancel the overlay (X), not Discard
      const x = modalLocator.locator('button[aria-label="Dismiss"]').last();
      if (await x.isVisible().catch(() => false)) await x.click().catch(() => {});
    }

    // Check progress + button text
    const submitBtn = modalLocator.locator('button:has-text("Submit application")');
    const reviewBtn = modalLocator.locator('button:has-text("Review")');
    const nextBtn = modalLocator.locator('button:has-text("Next")');
    const continueBtn = modalLocator.locator('button:has-text("Continue applying")');

    // Read all open-text / numeric inputs + their labels
    const fields = await modalLocator.evaluate((modal) => {
      const labels = [];
      const inputs = modal.querySelectorAll('input[type="text"], input[type="number"], textarea, select');
      inputs.forEach((el) => {
        let labelText = '';
        const id = el.id;
        if (id) {
          const lab = modal.querySelector(`label[for="${id}"]`);
          if (lab) labelText = lab.innerText.trim();
        }
        if (!labelText) {
          const closest = el.closest('[data-test-form-element], .jobs-easy-apply-form-element, label');
          if (closest) labelText = closest.innerText.trim();
        }
        labels.push({
          tag: el.tagName,
          type: el.type || null,
          id,
          label: labelText,
          value: el.value || '',
          required: el.required || el.getAttribute('aria-required') === 'true',
        });
      });
      // Also collect fieldset (radio group) labels
      const groups = [];
      modal.querySelectorAll('fieldset').forEach((fs) => {
        const legend = fs.querySelector('legend')?.innerText?.trim() || '';
        const options = [...fs.querySelectorAll('input[type="radio"]')].map((r) => ({
          value: r.value,
          checked: r.checked,
          name: r.name,
        }));
        if (options.length) groups.push({ legend, options });
      });
      return { fields: labels, radioGroups: groups };
    });

    // Fill text/number/textarea fields using canned answers
    for (const f of fields.fields) {
      if (f.value && f.value.length > 0) continue; // already filled (auto-fill from profile)
      const match = matchAnswer(f.label, answers);
      if (!match) {
        if (f.required) unanswered.push({ label: f.label, type: f.tag });
        continue;
      }
      let value = match.value;
      if (f.type === 'number') {
        const n = numericAnswer(value);
        if (n === null) {
          unanswered.push({ label: f.label, type: 'number', matched_key: match.key, raw: value });
          continue;
        }
        value = String(n);
      }
      const selector = f.id ? `#${CSS.escape(f.id)}` : null;
      if (!selector) {
        unanswered.push({ label: f.label, type: f.tag, reason: 'no id' });
        continue;
      }
      try {
        const inp = modalLocator.locator(selector);
        await inp.fill(value, { timeout: 4000 });
      } catch (err) {
        unanswered.push({ label: f.label, type: f.tag, reason: `fill failed: ${err.message}` });
      }
    }

    // Handle radio groups
    for (const group of fields.radioGroups) {
      const alreadyChecked = group.options.some((o) => o.checked);
      if (alreadyChecked) continue;
      const match = matchAnswer(group.legend, answers);
      if (!match) {
        unanswered.push({ label: group.legend, type: 'radio' });
        continue;
      }
      const desired = String(match.value).toLowerCase();
      const option = group.options.find((o) => desired.includes(String(o.value).toLowerCase()));
      if (option) {
        await modalLocator.locator(`input[type="radio"][name="${option.name}"][value="${option.value}"]`).check().catch(() => {});
      } else {
        unanswered.push({ label: group.legend, type: 'radio', options: group.options.map((o) => o.value) });
      }
    }

    // If we have unanswered REQUIRED fields, save and stop
    if (unanswered.length > 0) {
      // Click the X (close), confirm "Save"
      const closeBtn = modalLocator.locator('button[aria-label="Dismiss"]').first();
      await closeBtn.click().catch(() => {});
      await page.waitForTimeout(800);
      const saveBtn = page.locator('button:has-text("Save")');
      if (await saveBtn.isVisible({ timeout: 1000 }).catch(() => false)) await saveBtn.click();
      return { status: 'saved_in_progress', unanswered, steps: stepCount };
    }

    // Move forward: Submit > Review > Next
    if (await submitBtn.isVisible({ timeout: 300 }).catch(() => false)) {
      await submitBtn.click();
      await page.waitForTimeout(4000);
      return { status: 'applied', unanswered: [], steps: stepCount };
    }
    if (await reviewBtn.isVisible({ timeout: 300 }).catch(() => false)) {
      await reviewBtn.click();
      await page.waitForTimeout(600);
      continue;
    }
    if (await nextBtn.isVisible({ timeout: 300 }).catch(() => false)) {
      await nextBtn.click();
      await page.waitForTimeout(600);
      continue;
    }
    if (await continueBtn.isVisible({ timeout: 300 }).catch(() => false)) {
      await continueBtn.click();
      await page.waitForTimeout(600);
      continue;
    }

    return { status: 'failed', reason: 'no advance button found', steps: stepCount, unanswered };
  }

  return { status: 'failed', reason: 'max steps exceeded', steps: stepCount, unanswered };
}

// ─── Main applyTo ───────────────────────────────────────────────

export async function applyTo(jobId, { skipFilters = false, dryRun = false, url: urlOverride = null } = {}) {
  const auditDir = ensureAuditDir();
  const browser = await makeContext();
  const page = await browser.newPage();
  const url = urlOverride || `https://www.linkedin.com/jobs/view/${jobId}/`;
  const auditId = jobId || `url-${String(url).replace(/[^a-z0-9]+/gi, '-').slice(-40)}`;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const signals = await extractJobSignals(page);

    // Hard filters
    if (!skipFilters) {
      const filterCheck = passesHardFilters({
        company: signals.company,
        location: signals.location,
        salaryText: signals.salary,
      });
      if (!filterCheck.ok) {
        return { ok: true, status: 'skipped', job_id: jobId, ...signals, reason: filterCheck.reason };
      }
      if (signals.submitted) {
        return { ok: true, status: 'skipped', job_id: jobId, ...signals, reason: 'already submitted' };
      }
      if (!signals.isEasyApply) {
        return { ok: true, status: 'skipped', job_id: jobId, ...signals, reason: 'not Easy Apply' };
      }
      // Patch B (2026-05-28): When LinkedIn says "Responses managed off LinkedIn", the Easy Apply badge is misleading —
      // the actual apply routes through an external employer portal (Ladders, Loftware, SymphonyAI, Fueled, etc.).
      // Don't waste cycles fighting an iframe that won't open. Mark as materials_ready_off_li so the runner writes
      // a "Materials Ready - Off-LinkedIn" row and Sav can batch-submit manually or via a future Greenhouse adapter.
      if (signals.offLinkedIn) {
        return {
          ok: true,
          status: 'materials_ready',
          job_id: jobId,
          ...signals,
          reason: 'Off-LinkedIn flow — Easy Apply badge is decorative, actual apply is external. Needs manual submit OR Greenhouse/Workday adapter (Phase 2).',
        };
      }
    }

    const beforeShot = join(auditDir, `${auditId}-before.png`);
    await page.screenshot({ path: beforeShot, fullPage: false });

    // Dry-run: report what WOULD happen without clicking Easy Apply
    if (dryRun) {
      return {
        ok: true,
        status: 'dry_run_qualifying',
        job_id: jobId,
        title: signals.title,
        company: signals.company,
        location: signals.location,
        salary: signals.salary,
        url,
        reason: 'Dry-run mode: passes filters and is Easy Apply, would submit',
        audit: { before: beforeShot },
      };
    }

    // Open Easy Apply — LinkedIn renders this as an <a> with aria-label "Easy Apply to this job",
    // NOT a <button>. Use text/locator instead of getByRole('button').
    const easyApplyBtn = page.locator(
      'a[aria-label*="Easy Apply" i], button[aria-label*="Easy Apply" i], a:has-text("Easy Apply"), button:has-text("Easy Apply")'
    ).first();
    await easyApplyBtn.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    await easyApplyBtn.click({ timeout: 8000 });
    await page.waitForTimeout(3000);

    const modal = page.locator('[role="dialog"]').first();
    if (!(await modal.isVisible({ timeout: 5000 }).catch(() => false))) {
      const afterShot = join(auditDir, `${auditId}-no-modal.png`);
      await page.screenshot({ path: afterShot, fullPage: false });
      return { ok: false, status: 'failed', job_id: jobId, ...signals, reason: 'Easy Apply modal did not open', audit: { before: beforeShot, after: afterShot } };
    }

    const answers = await loadAnswers();
    const walk = await walkForm(page, modal, jobId, answers);

    const afterShot = join(auditDir, `${auditId}-${walk.status}.png`);
    await page.screenshot({ path: afterShot, fullPage: false });

    return {
      ok: true,
      status: walk.status,
      job_id: jobId,
      title: signals.title,
      company: signals.company,
      location: signals.location,
      salary: signals.salary,
      url,
      submitted_at: walk.status === 'applied' ? new Date().toISOString() : null,
      unanswered_questions: walk.unanswered || [],
      reason: walk.reason || null,
      audit: { before: beforeShot, after: afterShot },
    };
  } catch (err) {
    const errorShot = join(auditDir, `${auditId}-error.png`);
    await page.screenshot({ path: errorShot, fullPage: false }).catch(() => {});
    // Re-grab signals so we know WHAT failed (title/company even on error)
    let lastSignals = {};
    try { lastSignals = await extractJobSignals(page); } catch (_) {}
    return {
      ok: false,
      status: 'failed',
      job_id: jobId,
      title: lastSignals.title || null,
      company: lastSignals.company || null,
      url,
      reason: err.message.split('\n')[0],
      audit: { error: errorShot },
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── CLI ────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2];
  if (arg === '--login') {
    await login();
  } else if (arg === '--apply' && process.argv[3]) {
    const jobId = process.argv[3];
    const result = await applyTo(jobId);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } else {
    console.error('Usage:\n  node easy-apply-bot.mjs --login\n  node easy-apply-bot.mjs --apply <jobId>');
    process.exit(1);
  }
}
