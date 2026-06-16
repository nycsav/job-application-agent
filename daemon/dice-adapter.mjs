#!/usr/bin/env node
/**
 * Dice Adapter — introspection-driven Easy Apply submitter for Dice (DHI Group).
 *
 * WHY THIS IS ITS OWN MODULE (not a submitGreenhouse-style fixed-selector fn):
 *   Dice is a JS-rendered SPA. Apply forms are NOT in static HTML — they are
 *   built client-side after login, so fixed selectors break run-to-run. This
 *   adapter introspects the LIVE logged-in DOM (the same approach as
 *   easy-apply-bot.mjs walkForm + submit-ready.mjs fillKnownQuestions) and maps
 *   enumerated fields → canned answers via canned-answers.mjs matchAnswer.
 *
 * URL SHAPES (both resolve to the SAME job-detail SPA view):
 *   - /job-detail/<uuid>   canonical posting page; click "Easy apply"/"Apply now"
 *   - /direct-apply/<uuid> deep-links the same page with the apply flow
 *                          auto-triggered (so detect an already-open dialog
 *                          first, to avoid double-firing the trigger).
 *   Neither URL reveals the mechanism. After clicking Apply, Dice resolves to
 *   one of:
 *     (a) Dice-hosted Easy Apply (Technologist Apply Flow) — the ONLY
 *         autonomous-eligible path; asks work auth inline.
 *     (b) External redirect to an employer ATS (Greenhouse/Workday/iCIMS/
 *         SmartRecruiters/Bullhorn). We DETECT and RETURN, never submit there.
 *     (c) Login wall / CAPTCHA → bail to MANUAL.
 *
 * SAFETY MODEL (matches submit-ready.mjs guard stack):
 *   - Uses the SHARED persistent logged-in profile (.secrets/browser-profile),
 *     never fresh headless — same anti-bot reasoning that forced the persistent
 *     profile for Ashby on 2026-06-12.
 *   - dryRun: fill + screenshot, NEVER click the final Submit.
 *   - Bails to MANUAL the moment a REQUIRED field has no canned answer, or an
 *     external / login / CAPTCHA wall appears. MANUAL = caller leaves the role
 *     "Materials Ready" in Notion with materials staged (this module does NOT
 *     touch Notion).
 *   - Rejection text is checked BEFORE success text (readSubmitOutcome shape).
 *
 * RETURN CONTRACT (so submit-ready.mjs can route on it):
 *   { status, platform, ... }
 *     status: 'applied'      → submitted + confirmed (Dice Easy Apply)
 *             'redirect'     → flow left dice.com; { platform, url } so the
 *                              caller can re-route through detectPlatform/submitX
 *             'manual'       → needs a human (login wall, CAPTCHA, unanswered
 *                              required field, no submit button); materials
 *                              already staged by caller
 *             'dry_run'      → filled + screenshotted, did not submit
 *             'failed'       → reached the form but could not confirm outcome
 *   plus: reason, unanswered (labels), audit { before, after }, snippet.
 *
 * NOT YET IN AUTONOMOUS_PLATFORMS: per the build plan, Dice stays OUT of
 * submit-ready.mjs's AUTONOMOUS_PLATFORMS until live-verified under human
 * supervision (task 6). First runs are observe-and-report so a human confirms
 * the real selectors from the audit screenshots this module writes.
 *
 * LIVE-DOM ASSUMPTIONS flagged inline with `// LIVE-VERIFY:` — every one must be
 * confirmed against a real introspect dump before flipping to autonomous.
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { loadAnswers, matchAnswer, numericAnswer } from './canned-answers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const AUDIT_ROOT = join(ROOT, '.audit');

// ─── Audit dir (same shape as submit-ready.mjs / easy-apply-bot.mjs) ──

function ensureAuditDir() {
  const today = new Date().toISOString().slice(0, 10);
  const dir = join(AUDIT_ROOT, today);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Persistent profile context (shared logged-in browser) ──────────
// Mirrors easy-apply-bot.mjs makeContext() exactly so we reuse the SAME
// .secrets/browser-profile (Dice login lives there once a human logs in via
// `node daemon/easy-apply-bot.mjs --login` and signs into dice.com too).

async function makeContext() {
  const browser = await chromium.launchPersistentContext(
    join(ROOT, '.secrets', 'browser-profile'),
    { headless: process.env.HEADLESS !== 'false', viewport: { width: 1280, height: 900 } }
  );
  return browser;
}

// ─── Outcome reader (readSubmitOutcome shape, Dice copy extended) ───
// Copied from submit-ready.mjs readSubmitOutcome: rejections FIRST so a
// "couldn't submit"/"missing entry" banner is never misread as success.
// Success regex EXTENDED for Dice's Easy Apply confirmation wording.
// LIVE-VERIFY: confirm the exact Dice success string from the first live
// after-screenshot and tighten this regex to it.

function readSubmitOutcome(text) {
  const neg = text.match(
    /couldn.t submit[^\n.]*|flagged as possible spam[^\n.]*|needs corrections[^\n.]*|missing entry for required[^\n.]*|please (complete|fix|answer)[^\n.]*|required field[^\n.]*/i
  );
  if (neg) return { ok: false, negative: neg[0].trim().slice(0, 160) };
  const ok = /thank you|application (has been )?(received|submitted|complete)|we.ve received your|successfully (submitted|applied)|application sent|you have applied|applied to this job|your application has been submitted/i.test(text);
  return { ok, negative: null };
}

// ─── Login / CAPTCHA / external-redirect detection ──────────────────

const LOGIN_WALL_RE = /sign in|log ?in|create (an )?account|password|forgot your password/i;
const CAPTCHA_RE = /captcha|verify you are human|i'?m not a robot|cloudflare|are you a robot|press & hold|challenge/i;

/**
 * Classify a post-Apply destination. Returns one of:
 *   { kind: 'dice' }                     still on dice.com Easy Apply flow
 *   { kind: 'redirect', platform, url }  left dice.com → employer ATS
 *   { kind: 'login' }                    login/auth wall
 *   { kind: 'captcha' }                  bot challenge
 * Caller bails to MANUAL on login/captcha and returns {status:'redirect'} on
 * redirect so submit-ready.mjs can re-route via its own detectPlatform.
 */
function classifyDestination(currentUrl, bodyText) {
  const url = String(currentUrl || '');
  const onDice = /(^|\.)dice\.com/i.test(url) || /^https?:\/\/[^/]*dice\.com/i.test(url);

  if (!onDice && url && !/^about:blank/i.test(url)) {
    // Left dice.com — name the employer ATS so the caller can re-route.
    // (Detection only — we never submit on the external site.)
    let platform = 'external';
    if (/boards\.greenhouse\.io|greenhouse\.io/i.test(url)) platform = 'greenhouse';
    else if (/myworkdayjobs\.com|workday\.com/i.test(url)) platform = 'workday';
    else if (/icims\.com/i.test(url)) platform = 'icims';
    else if (/smartrecruiters\.com/i.test(url)) platform = 'smartrecruiters';
    else if (/bullhorn|talentrackr|bullhornstaffing/i.test(url)) platform = 'bullhorn';
    else if (/jobs\.lever\.co/i.test(url)) platform = 'lever';
    else if (/jobs\.ashbyhq\.com|app\.ashbyhq\.com/i.test(url)) platform = 'ashby';
    return { kind: 'redirect', platform, url };
  }

  // Still on dice.com — check for an auth/bot wall in the page text.
  if (CAPTCHA_RE.test(bodyText)) return { kind: 'captcha' };
  // Only treat as login wall if there's NO apply form present — the Easy Apply
  // flow itself never shows password fields. LIVE-VERIFY: confirm the logged-in
  // apply view does not contain the word "sign in" in nav/footer chrome (if it
  // does, tighten this to look for an actual password input instead).
  if (LOGIN_WALL_RE.test(bodyText) && !/work authorization|easy apply|apply (now|flow)|submit application/i.test(bodyText)) {
    return { kind: 'login' };
  }
  return { kind: 'dice' };
}

// ─── Apply-flow trigger ─────────────────────────────────────────────

/**
 * Open the Dice apply flow. For /direct-apply links it often auto-opens, so we
 * detect an already-open dialog FIRST and skip the click to avoid double-firing.
 * Returns true if a dialog/form is believed open, false if no trigger found.
 *
 * LIVE-VERIFY: the Apply button text + the dialog container selector. These are
 * best-guess from the redesigned "Technologist Apply Flow" — confirm against a
 * live screenshot before trusting.
 */
async function openApplyFlow(page) {
  // 1. Is an apply dialog/flow already open? (direct-apply auto-trigger)
  const openDialog = page.locator(
    '[role="dialog"], [class*="apply" i][class*="modal" i], [data-testid*="apply" i], form[class*="apply" i]'
  ).first();
  if (await openDialog.isVisible({ timeout: 1500 }).catch(() => false)) {
    return true;
  }

  // 2. Click an Apply trigger. Dice uses "Easy apply" and "Apply now"; some
  //    postings show only "Apply". LIVE-VERIFY: exact button label + casing.
  const applyBtn = page.locator(
    [
      'button:has-text("Easy apply")',
      'button:has-text("Easy Apply")',
      'a:has-text("Easy apply")',
      'button:has-text("Apply now")',
      'button:has-text("Apply Now")',
      'a:has-text("Apply now")',
      'button[aria-label*="apply" i]',
      'a[aria-label*="apply" i]',
      'button:has-text("Apply")',
    ].join(', ')
  ).first();

  if (await applyBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
    await applyBtn.click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(1800);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    return true;
  }
  return false;
}

// ─── Resume / cover-letter attachment ───────────────────────────────

/**
 * Attach a file to the input whose surrounding text matches labelRegex.
 * Identical contract to submit-ready.mjs attachFileByLabel() — duplicated here
 * so the adapter has no import cycle with submit-ready.mjs.
 * Returns true if attached.
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
      await input.setInputFiles(filePath).catch(() => {});
      return true;
    }
  }
  return false;
}

/**
 * Handle the resume section. Dice prefers a SAVED resume (radio/card) once
 * logged in; we prefer that path, then fall back to uploading resumePath.
 *
 * LIVE-VERIFY: the saved-resume radio/card selector. Best-guess from the
 * "select a resume" section in the Technologist Apply Flow.
 * Returns { method: 'saved'|'uploaded'|'none' }.
 */
async function ensureResume(page, resumePath) {
  // 1. Prefer a pre-saved resume already on the Dice account.
  const savedResume = page.locator(
    [
      'input[type="radio"][name*="resume" i]',
      '[role="radio"][aria-label*="resume" i]',
      '[data-testid*="resume" i][role="button"]',
      'label:has-text("resume") input[type="radio"]',
    ].join(', ')
  ).first();
  if (await savedResume.isVisible({ timeout: 1500 }).catch(() => false)) {
    await savedResume.check().catch(() => savedResume.click().catch(() => {}));
    return { method: 'saved' };
  }

  // 2. Otherwise upload. Label-aware first, then first file input as fallback.
  if (resumePath) {
    const attached = await attachFileByLabel(page, /resume|cv\b/i, resumePath);
    if (attached) return { method: 'uploaded' };
    const fileInputs = page.locator('input[type="file"]');
    if ((await fileInputs.count()) > 0) {
      await fileInputs.first().setInputFiles(resumePath).catch(() => {});
      return { method: 'uploaded' };
    }
  }
  return { method: 'none' };
}

/**
 * Best-effort cover letter — only if a cover input exists. Never blocks.
 * Tries a file input labelled "cover" first, then a cover-letter textarea.
 */
async function maybeCoverLetter(page, coverLetter) {
  if (!coverLetter) return false;
  if (coverLetter.docxPath) {
    const attached = await attachFileByLabel(page, /cover/i, coverLetter.docxPath);
    if (attached) return true;
  }
  if (coverLetter.text) {
    const ta = page.locator('textarea[name*="cover" i], textarea[id*="cover" i], textarea[aria-label*="cover" i]').first();
    if (await ta.isVisible({ timeout: 1200 }).catch(() => false)) {
      await ta.fill(String(coverLetter.text)).catch(() => {});
      return true;
    }
  }
  return false;
}

// ─── Native field introspection + fill ──────────────────────────────
// Mirrors submit-ready.mjs fillKnownQuestions(): enumerate native inputs,
// selects, textareas, and radio groups; resolve each label; matchAnswer;
// fill. Returns labels of REQUIRED fields still empty (these block submit).

async function fillNativeFields(page, formData) {
  const answers = await loadAnswers();
  const unfilled = [];

  // Text/number/textarea/select — same enumeration shape as fillKnownQuestions.
  const fields = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('input[type="text"], input[type="number"], input[type="tel"], input[type="email"], input[type="url"], textarea, select').forEach((el) => {
      if (el.value && el.value.length > 0 && el.tagName !== 'SELECT') return;
      let label = '';
      if (el.id) label = document.querySelector(`label[for="${el.id}"]`)?.innerText?.trim() || '';
      if (!label) label = el.getAttribute('aria-label') || '';
      if (!label) label = el.closest('label, .field, [class*="question" i], [class*="field" i]')?.innerText?.trim().slice(0, 200) || '';
      if (!label) label = el.getAttribute('placeholder') || '';
      out.push({
        tag: el.tagName,
        type: el.type || null,
        id: el.id || null,
        name: el.name || null,
        label,
        value: el.value || '',
        required: el.required || el.getAttribute('aria-required') === 'true',
        options: el.tagName === 'SELECT' ? [...el.options].map(o => o.text).filter(Boolean) : null,
      });
    });
    return out;
  }).catch(() => []);

  // Profile contact fields first (name/email/phone/linkedin/location) — these
  // come from formData (buildFormData in submit-ready.mjs), not canned answers.
  // LIVE-VERIFY: Dice's Easy Apply may prefill these from the account; the
  // `if (el.value)` skip above means we only fill blanks.
  const profileMap = [
    [/first ?name/i, formData.first_name],
    [/last ?name/i, formData.last_name],
    [/full ?name|^name\b|your name/i, formData.full_name],
    [/e-?mail/i, formData.email],
    [/phone|mobile|telephone/i, formData.phone],
    [/linkedin/i, formData.linkedin_url],
    [/website|portfolio|personal url/i, formData.website],
    [/current (location|city)|^location\b|city\b/i, formData.location],
  ];

  for (const f of fields) {
    if (f.tag === 'SELECT' && f.value) continue;
    const sel = f.id ? `[id="${CSS_ESC(f.id)}"]` : (f.name ? `[name="${CSS_ESC(f.name)}"]` : null);

    // 1. Profile contact fields.
    let profileVal = null;
    for (const [re, val] of profileMap) {
      if (val && re.test(f.label)) { profileVal = val; break; }
    }
    if (profileVal && sel && f.tag !== 'SELECT') {
      try { await page.locator(sel).first().fill(String(profileVal), { timeout: 3000 }); continue; }
      catch { /* fall through to canned-answer attempt */ }
    }

    // 2. Canned answers (work auth, salary, years-of-X, EEO narrative, etc.).
    if (!f.label) { if (f.required && !f.value) unfilled.push('(unlabeled field)'); continue; }
    const match = matchAnswer(f.label, answers);
    if (!match) {
      if (profileVal) continue; // profile handled it even if no canned match
      if (f.required && !f.value) unfilled.push(f.label.slice(0, 80));
      continue;
    }
    if (!sel) { if (f.required && !f.value) unfilled.push(f.label.slice(0, 80)); continue; }
    try {
      if (f.tag === 'SELECT') {
        const want = String(match.value).toLowerCase();
        const opt = (f.options || []).find(o =>
          want.startsWith(o.toLowerCase()) || o.toLowerCase() === want ||
          (want.split(/[\s,]/)[0] && o.toLowerCase().includes(want.split(/[\s,]/)[0]))
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

  // Native radio groups (work auth Yes/No, EEO decline path, etc.).
  // Same shape as submit-ready.mjs fillKnownQuestions radio handling.
  const radioGroups = await page.evaluate(() => {
    const groups = {};
    document.querySelectorAll('input[type="radio"]').forEach((r) => {
      // Skip the resume-selection radios — handled by ensureResume().
      if (/resume/i.test(r.name || '') || /resume/i.test(r.id || '')) return;
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

  return unfilled;
}

// CSS.escape isn't available in Node page.evaluate context here; this is a
// minimal escaper for id/name values used in attribute selectors.
function CSS_ESC(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

// ─── Custom (non-native) widget introspection + fill ────────────────
// HIGHEST-VALUE GAP per the widget research: Dice/Ashby EEO + work-auth fields
// often render as ARIA comboboxes/listboxes (role=combobox / aria-haspopup),
// NOT native <select>, so they fall through fillNativeFields() silently and
// block submit. matchAnswer already maps veteran/disability/race/gender to the
// canned decline values — only the FILL MECHANISM is missing. We add it here.
//
// LIVE-VERIFY (all selectors below): combobox trigger selector, the portal
// where [role=option] renders (Ashby renders options in a DETACHED portal at
// document root — query page-global, do NOT scope under the trigger), and the
// exact decline-option wording. Confirm from a live introspect dump.

async function fillCustomWidgets(page, alreadyUnfilled) {
  const answers = await loadAnswers();
  const unfilled = [];

  // Enumerate candidate combobox triggers + their accessible labels.
  const widgets = await page.evaluate(() => {
    const out = [];
    const seen = new Set();
    const triggers = document.querySelectorAll(
      '[role="combobox"], [aria-haspopup="listbox"], button[aria-haspopup="true"], [class*="_select" i]:not(select)'
    );
    triggers.forEach((el, idx) => {
      // Skip if it's actually wrapping a native select or a plain text input.
      if (el.tagName === 'SELECT') return;
      if (seen.has(el)) return;
      seen.add(el);

      // Resolve accessible label:
      //  aria-labelledby target text → aria-label → nearest field/question
      //  container's first line → preceding <label>.
      let label = '';
      const lbBy = el.getAttribute('aria-labelledby');
      if (lbBy) {
        label = lbBy.split(/\s+/).map(id => document.getElementById(id)?.innerText?.trim() || '').join(' ').trim();
      }
      if (!label) label = el.getAttribute('aria-label') || '';
      if (!label) {
        const container = el.closest('[class*="field" i], [class*="question" i], [class*="fieldEntry" i], [class*="application-form-field" i]');
        if (container) label = (container.innerText || '').split('\n')[0]?.trim() || '';
      }
      if (!label) {
        let prev = el.previousElementSibling;
        while (prev && !label) {
          if (prev.tagName === 'LABEL' || /label/i.test(prev.className)) label = (prev.innerText || '').trim();
          prev = prev.previousElementSibling;
        }
      }

      // Stable handle for re-selection from Playwright: prefer id, else stamp a
      // data-attr we can target.
      let handle = el.id ? `#${el.id}` : null;
      if (!handle) {
        const stamp = `dice-combo-${idx}`;
        el.setAttribute('data-dice-combo', stamp);
        handle = `[data-dice-combo="${stamp}"]`;
      }
      out.push({ handle, label: (label || '').slice(0, 200) });
    });
    return out;
  }).catch(() => []);

  // Decline-to-answer option matcher (the PRIMARY path: all EEO canned values
  // are "Prefer not to answer" / "Not a protected veteran").
  const declineRe = /decline to (self-identify|answer)|prefer not to (say|answer|disclose)|i don.?t wish to answer|do not wish|not a protected veteran/i;

  for (const w of widgets) {
    if (!w.label) continue;
    const match = matchAnswer(w.label, answers);
    if (!match) {
      // Don't blanket-fail every combobox — only the ones we KNOW map to a
      // canned answer matter for the decline path. Unmatched comboboxes are
      // left to the required-field check (fillNativeFields can't see them, so
      // a genuinely-required unmatched combobox surfaces as an unconfirmed
      // outcome rather than a fill here).
      continue;
    }
    const wantStr = String(match.value);
    const wantFirst = wantStr.split(/[\s,/]+/)[0];

    try {
      const combo = page.locator(w.handle).first();
      await combo.scrollIntoViewIfNeeded().catch(() => {});
      await combo.click({ timeout: 3000 });

      // Wait for options. Ashby/Dice render these in a detached portal at the
      // document root, so query PAGE-GLOBAL, not scoped under the combo.
      const optsAppeared = await page.waitForSelector('[role="option"]', { timeout: 3000 })
        .then(() => true).catch(() => false);
      if (!optsAppeared) {
        // Fallback: click an inner input/textbox to open the listbox.
        await combo.locator('input, [role="textbox"]').first().click({ timeout: 1500 }).catch(() => {});
        await page.waitForSelector('[role="option"]', { timeout: 2000 }).catch(() => {});
      }

      // Build a preference order of option matchers:
      //  1. exact-ish value match (RegExp from the FIRST word of the canned value)
      //  2. full canned value substring
      //  3. decline-to-answer (the canned EEO values ARE declines, so this is
      //     usually the same target — kept as an explicit fallback)
      let picked = false;
      const candidates = [
        wantFirst ? new RegExp(wantFirst.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null,
        new RegExp(wantStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 40), 'i'),
        declineRe,
      ].filter(Boolean);

      for (const re of candidates) {
        const opt = page.getByRole('option', { name: re }).first();
        if (await opt.isVisible({ timeout: 1000 }).catch(() => false)) {
          await opt.click({ timeout: 1500 }).catch(() => {});
          picked = true;
          break;
        }
      }

      if (!picked) {
        // Last resort: if the canned value is itself a decline, click any
        // visible decline option page-global.
        if (declineRe.test(wantStr)) {
          const opt = page.getByRole('option', { name: declineRe }).first();
          if (await opt.isVisible({ timeout: 800 }).catch(() => false)) {
            await opt.click({ timeout: 1500 }).catch(() => {});
            picked = true;
          }
        }
      }

      if (!picked) unfilled.push(w.label.slice(0, 80));
    } catch {
      unfilled.push(w.label.slice(0, 80));
    }
  }

  // Combine: a label the native pass flagged as unfilled but we just filled via
  // a combobox should NOT remain in the failure list.
  const filledLabels = new Set();
  for (const w of widgets) {
    if (!unfilled.includes(w.label.slice(0, 80))) filledLabels.add(w.label.slice(0, 80));
  }
  const residual = (alreadyUnfilled || []).filter(l => !filledLabels.has(l));
  return [...new Set([...residual, ...unfilled])];
}

// ─── Wizard advance (Submit > Review > Next > Continue) ─────────────
// Mirrors easy-apply-bot.mjs walkForm advance order. Returns the action taken
// so the caller knows whether it just submitted.
// LIVE-VERIFY: exact wizard button labels in the Technologist Apply Flow.

async function advanceWizard(page, { allowSubmit }) {
  const submitBtn = page.locator(
    'button:has-text("Submit application"), button:has-text("Submit"), button[type="submit"]'
  ).first();
  const reviewBtn = page.locator('button:has-text("Review")').first();
  const nextBtn = page.locator('button:has-text("Next")').first();
  const continueBtn = page.locator('button:has-text("Continue")').first();

  if (allowSubmit && await submitBtn.isVisible({ timeout: 500 }).catch(() => false)) {
    await submitBtn.click().catch(() => {});
    return 'submitted';
  }
  if (await reviewBtn.isVisible({ timeout: 500 }).catch(() => false)) {
    await reviewBtn.click().catch(() => {});
    return 'review';
  }
  if (await nextBtn.isVisible({ timeout: 500 }).catch(() => false)) {
    await nextBtn.click().catch(() => {});
    return 'next';
  }
  if (await continueBtn.isVisible({ timeout: 500 }).catch(() => false)) {
    await continueBtn.click().catch(() => {});
    return 'continue';
  }
  // Submit present but we're in dry-run (allowSubmit=false) → report it.
  if (await submitBtn.isVisible({ timeout: 500 }).catch(() => false)) {
    return 'submit_blocked_dry_run';
  }
  return 'none';
}

// ─── Public entrypoint ──────────────────────────────────────────────

/**
 * applyToDice(role, opts)
 *
 * @param {object} role  { title, company, apply_url, ... }
 * @param {object} opts  {
 *    resumePath: string,                       // routed resume (selectResume)
 *    coverLetter: { docxPath, text } | null,   // staged cover letter
 *    formData: object,                         // buildFormData() output
 *    dryRun: boolean,                          // fill + screenshot, never submit
 * }
 * @returns {Promise<object>} see RETURN CONTRACT in the header.
 */
export async function applyToDice(role, opts = {}) {
  const { resumePath = null, coverLetter = null, formData = {}, dryRun = false } = opts;
  const auditDir = ensureAuditDir();
  const slug = `dice-${Date.now()}`;
  const beforeShot = join(auditDir, `${slug}-before.png`);
  const afterShot = join(auditDir, `${slug}-after.png`);
  const url = role.apply_url;

  if (!url) {
    return { status: 'manual', platform: 'dice', reason: 'No apply URL', audit: {} };
  }

  const browser = await makeContext();
  const page = await browser.newPage();

  try {
    // Land on the SPA. Both /job-detail and /direct-apply resolve to the same
    // view; let the SPA settle (domcontentloaded → networkidle → ~1.5–2s).
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
    await page.waitForTimeout(1800);
    await page.screenshot({ path: beforeShot, fullPage: false }).catch(() => {});

    // Early wall check before we even click Apply (logged-out / CAPTCHA).
    let bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
    let dest = classifyDestination(page.url(), bodyText);
    if (dest.kind === 'login') {
      await page.screenshot({ path: afterShot, fullPage: false }).catch(() => {});
      return { status: 'manual', platform: 'dice', reason: 'Login wall — Dice apply requires a logged-in account (re-run easy-apply-bot --login)', audit: { before: beforeShot, after: afterShot } };
    }
    if (dest.kind === 'captcha') {
      await page.screenshot({ path: afterShot, fullPage: false }).catch(() => {});
      return { status: 'manual', platform: 'dice', reason: 'CAPTCHA / bot challenge — never auto-solved; needs a human', audit: { before: beforeShot, after: afterShot } };
    }

    // Open the apply flow (auto-open for /direct-apply, click for /job-detail).
    const opened = await openApplyFlow(page);
    if (!opened) {
      await page.screenshot({ path: afterShot, fullPage: false }).catch(() => {});
      return { status: 'manual', platform: 'dice', reason: 'No Apply / Easy apply trigger found — likely externally-managed posting', audit: { before: beforeShot, after: afterShot } };
    }

    // Re-classify after clicking Apply — may have redirected off-site or hit a wall.
    await page.waitForTimeout(1200);
    bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
    dest = classifyDestination(page.url(), bodyText);

    if (dest.kind === 'redirect') {
      // Left dice.com → employer ATS. DO NOT submit here. Hand back to caller.
      await page.screenshot({ path: afterShot, fullPage: false }).catch(() => {});
      return {
        status: 'redirect',
        platform: dest.platform,
        url: dest.url,
        reason: `Dice redirected to external ATS (${dest.platform}) — caller should re-route`,
        audit: { before: beforeShot, after: afterShot },
      };
    }
    if (dest.kind === 'login') {
      await page.screenshot({ path: afterShot, fullPage: false }).catch(() => {});
      return { status: 'manual', platform: 'dice', reason: 'Login wall after clicking Apply', audit: { before: beforeShot, after: afterShot } };
    }
    if (dest.kind === 'captcha') {
      await page.screenshot({ path: afterShot, fullPage: false }).catch(() => {});
      return { status: 'manual', platform: 'dice', reason: 'CAPTCHA after clicking Apply — needs a human', audit: { before: beforeShot, after: afterShot } };
    }

    // ── Dice-hosted Easy Apply flow. Step the wizard, introspect each step. ──
    const MAX_STEPS = 8;
    let allUnfilled = [];
    let submitted = false;

    for (let step = 0; step < MAX_STEPS; step++) {
      await page.waitForTimeout(800);

      // Resume + cover letter (idempotent — only fills blanks / re-selects).
      const resumeRes = await ensureResume(page, resumePath);
      await maybeCoverLetter(page, coverLetter);

      // Native fields, then custom ARIA widgets (EEO / work-auth comboboxes).
      const nativeUnfilled = await fillNativeFields(page, formData);
      const widgetUnfilled = await fillCustomWidgets(page, nativeUnfilled);
      allUnfilled = widgetUnfilled;

      // BAIL TO MANUAL if a required field has no canned answer on this step.
      if (allUnfilled.length > 0) {
        await page.screenshot({ path: afterShot, fullPage: true }).catch(() => {});
        return {
          status: 'manual',
          platform: 'dice',
          reason: `Required field(s) without a canned answer: ${allUnfilled.join(' | ')}`,
          unanswered: allUnfilled,
          resume_method: resumeRes.method,
          audit: { before: beforeShot, after: afterShot },
        };
      }

      // Advance. In dry-run we never click Submit — we report and stop.
      const action = await advanceWizard(page, { allowSubmit: !dryRun });

      if (action === 'submit_blocked_dry_run') {
        await page.screenshot({ path: afterShot, fullPage: true }).catch(() => {});
        return {
          status: 'dry_run',
          platform: 'dice',
          reason: 'DRY RUN: form filled, Submit reached but NOT clicked',
          resume_method: resumeRes.method,
          audit: { before: beforeShot, after: afterShot },
        };
      }
      if (action === 'submitted') { submitted = true; break; }
      if (action === 'none') {
        // No advance button and nothing left to fill. If dry-run, treat as a
        // successful fill stop; otherwise we can't confirm → failed.
        if (dryRun) {
          await page.screenshot({ path: afterShot, fullPage: true }).catch(() => {});
          return { status: 'dry_run', platform: 'dice', reason: 'DRY RUN: form filled, no Submit step reached', audit: { before: beforeShot, after: afterShot } };
        }
        await page.screenshot({ path: afterShot, fullPage: true }).catch(() => {});
        return { status: 'failed', platform: 'dice', reason: 'No advance/submit button found on apply flow', audit: { before: beforeShot, after: afterShot } };
      }
      // review / next / continue → loop to the next step.
    }

    if (!submitted) {
      await page.screenshot({ path: afterShot, fullPage: true }).catch(() => {});
      return { status: 'failed', platform: 'dice', reason: `Wizard exceeded ${MAX_STEPS} steps without submitting`, audit: { before: beforeShot, after: afterShot } };
    }

    // ── Confirm outcome. Poll ~12s; rejection text wins over success text. ──
    let text = '';
    let outcome = { ok: false, negative: null };
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(2000);
      text = await page.evaluate(() => document.body.innerText).catch(() => '');
      outcome = readSubmitOutcome(text);
      if (outcome.ok || outcome.negative) break;
    }

    await page.screenshot({ path: afterShot, fullPage: true }).catch(() => {});

    if (outcome.ok) {
      return {
        status: 'applied',
        platform: 'dice',
        reason: 'Confirmed',
        submitted_at: new Date().toISOString(),
        snippet: text.slice(0, 300),
        audit: { before: beforeShot, after: afterShot },
      };
    }
    // Submitted but unconfirmed (or rejected) → do NOT mark applied.
    return {
      status: 'failed',
      platform: 'dice',
      unconfirmed: !outcome.negative, // clicked submit; ambiguous (not a clean rejection) → quarantine upstream
      reason: outcome.negative ? `Form rejected: ${outcome.negative}` : 'Submit clicked but outcome unconfirmed',
      snippet: text.slice(0, 300),
      audit: { before: beforeShot, after: afterShot },
    };
  } catch (err) {
    await page.screenshot({ path: afterShot, fullPage: false }).catch(() => {});
    return {
      status: 'failed',
      platform: 'dice',
      reason: (err && err.message ? err.message.split('\n')[0] : String(err)),
      audit: { before: beforeShot, after: afterShot },
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── CLI (introspect / dry-run only; never auto-submits from CLI) ───
// Usage:
//   node daemon/dice-adapter.mjs --url <dice-url>            (dry-run)
//   HEADLESS=false node daemon/dice-adapter.mjs --url <url>  (watch it)
// Live submit is only ever invoked by submit-ready.mjs once Dice is added to
// AUTONOMOUS_PLATFORMS (after human verification — task 6).

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--url');
  const url = i !== -1 ? process.argv[i + 1] : null;
  if (!url) {
    console.error('Usage: node daemon/dice-adapter.mjs --url <dice-url> [--live]');
    process.exit(1);
  }
  const live = process.argv.includes('--live');
  const role = { title: 'CLI test', company: 'CLI test', apply_url: url };
  // CLI defaults to DRY RUN for safety; --live still requires submit-ready's
  // guard stack in production, so this CLI path is for introspection only.
  const formData = {
    first_name: 'Sav', last_name: 'Banerjee', full_name: 'Sav Banerjee',
    email: '', phone: '', linkedin_url: '', website: '', location: 'New York, NY',
  };
  const res = await applyToDice(role, { formData, dryRun: !live });
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.status === 'failed' ? 1 : 0);
}
