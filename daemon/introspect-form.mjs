#!/usr/bin/env node
/**
 * Introspect Form — the precision instrument.
 *
 * Given a job / apply URL, open it via the SHARED persistent browser profile
 * (mirrors makeContext() in daemon/easy-apply-bot.mjs; honors HEADLESS), click
 * an Apply button if a form isn't already present, wait for the form, then dump
 * a COMPLETE field inventory to .logs/introspect-<host>-<timestamp>.json and
 * print a readable summary.
 *
 * Why this exists:
 *   fillKnownQuestions() / walkForm() only touch native <select>, text/number/
 *   textarea, and native input[type=radio]. Ashby EEO fields (Gender, Race/
 *   Ethnicity, Veteran, Disability) and Greenhouse/Dice location pickers render
 *   as ARIA custom comboboxes/listboxes (role=combobox / role=listbox / div-based
 *   selects) that are NOT native <select> — so they fall through silently into
 *   unfilled[] and block submit ("missing entry for required"). This tool dumps
 *   the EXACT shape of every widget so adapters consume facts instead of
 *   guessing selectors. The decline path (Prefer not to answer / Not a protected
 *   veteran) is the primary path and MUST be reliable, so we surface the resolved
 *   accessible label of every custom widget — matchAnswer(label, answers) maps
 *   /veteran/, /disability/, /race|ethnicit/, /gender/ to the canned decline keys.
 *
 * For EVERY input/textarea/select/radio/checkbox/file input we capture:
 *   resolved label (label[for=id] → aria-label → aria-labelledby → wrapping
 *   fieldset legend → closest field-container text), best CSS selector
 *   (prefer #id; else [name]; else a stable nth path), tag, type, required flag,
 *   current value, and for selects/listboxes the option texts. We also detect
 *   CUSTOM widgets (role=combobox|listbox, [class*=select i], [aria-haspopup])
 *   vs native, and the submit button selector + text.
 *
 * Usage:
 *   node daemon/introspect-form.mjs <url>
 *   HEADLESS=false node daemon/introspect-form.mjs <url>   # watch it
 *
 * SAFETY: read-only. No form submission, no Notion writes, no credential entry.
 * It clicks ONLY an Apply / Apply-for-this-job trigger to surface the form, then
 * inspects. It never clicks a Submit button. If a CAPTCHA or login wall appears,
 * it captures what it can and flags it.
 */

import { chromium } from 'playwright';
import { writeFile } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const LOG_DIR = join(REPO_ROOT, '.logs');

// ─── Shared persistent profile (mirror easy-apply-bot makeContext) ─────────

async function makeContext() {
  const browser = await chromium.launchPersistentContext(
    join(REPO_ROOT, '.secrets', 'browser-profile'),
    { headless: process.env.HEADLESS !== 'false', viewport: { width: 1280, height: 900 } }
  );
  return browser;
}

function ensureLogDir() {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  return LOG_DIR;
}

function hostSlug(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-');
  } catch {
    return String(url).replace(/[^a-z0-9]+/gi, '-').slice(0, 40) || 'unknown';
  }
}

// ─── Form presence + Apply trigger ─────────────────────────────────────────

/**
 * A "form" is present if there's at least one fillable control beyond a bare
 * search box. We look for the common application anchors first, then fall back
 * to counting text/file inputs.
 */
async function formIsPresent(page) {
  return page.evaluate(() => {
    const sel = [
      'input[type="file"]',
      'input[type="email"]',
      'input[name*="first" i]',
      'input[name*="email" i]',
      'input[id*="email" i]',
      'textarea',
      '[data-test-form-element]',
      '.jobs-easy-apply-form-element',
      '[class*="application-form" i]',
    ];
    let hits = 0;
    for (const s of sel) hits += document.querySelectorAll(s).length;
    // Also treat 3+ text inputs as a form (covers custom ATSes with odd markup).
    const textInputs = document.querySelectorAll('input[type="text"], input:not([type])').length;
    return hits > 0 || textInputs >= 3;
  }).catch(() => false);
}

/**
 * Click the most likely Apply trigger if a form isn't already present. Mirrors
 * the Apply-button heuristics used by submitGreenhouse / submitAshby / submitLever
 * and the easy-apply-bot. Never clicks Submit. Returns the description of what
 * was clicked, or null.
 */
async function clickApplyIfNeeded(page) {
  if (await formIsPresent(page)) return null;

  const candidates = [
    'a[aria-label*="Easy Apply" i], button[aria-label*="Easy Apply" i]',
    'a:has-text("Easy Apply"), button:has-text("Easy Apply")',
    'a.postings-btn-submit',                                  // Lever
    'a:has-text("Apply for this job"), button:has-text("Apply for this job")',
    'button:has-text("Apply for this position")',             // Ashby
    'a:has-text("Apply Now"), button:has-text("Apply Now")',
    'a.btn-apply, .btn-apply',                                // Greenhouse listing
    'a:has-text("Apply"), button:has-text("Apply")',
  ];

  for (const selector of candidates) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
        const label = await el.innerText().catch(() => '') || await el.getAttribute('aria-label').catch(() => '') || selector;
        await el.click({ timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(1800);
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        return { selector, label: String(label).trim().slice(0, 60) };
      }
    } catch {}
  }
  return null;
}

// ─── The introspection pass (runs in page context) ─────────────────────────

/**
 * Walk every form control in the document (and inside any open [role=dialog])
 * and emit a normalized descriptor. Custom ARIA widgets are detected and
 * distinguished from native controls. Selectors prefer #id, then [name], then a
 * stable :nth-of-type path so adapters can re-find the element deterministically.
 *
 * Everything here is pure DOM — it runs inside page.evaluate, so no Playwright
 * objects cross the boundary.
 */
async function introspect(page) {
  return page.evaluate(() => {
    // ── label resolution ──────────────────────────────────────────────
    function textOf(el) {
      return (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    }
    function byIds(ids) {
      if (!ids) return '';
      return ids
        .split(/\s+/)
        .map((id) => textOf(document.getElementById(id)))
        .filter(Boolean)
        .join(' ')
        .trim();
    }
    function resolveLabel(el) {
      // 1. label[for=id]
      if (el.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab && textOf(lab)) return { label: textOf(lab), source: 'label[for]' };
      }
      // 2. aria-label
      const aria = el.getAttribute('aria-label');
      if (aria && aria.trim()) return { label: aria.trim(), source: 'aria-label' };
      // 3. aria-labelledby → referenced element text
      const labelledby = byIds(el.getAttribute('aria-labelledby'));
      if (labelledby) return { label: labelledby, source: 'aria-labelledby' };
      // 4. wrapping <label>
      const wrapLabel = el.closest('label');
      if (wrapLabel && textOf(wrapLabel)) return { label: textOf(wrapLabel).slice(0, 200), source: 'wrapping-label' };
      // 5. fieldset > legend
      const fs = el.closest('fieldset');
      if (fs) {
        const legend = fs.querySelector('legend');
        if (legend && textOf(legend)) return { label: textOf(legend), source: 'fieldset-legend' };
      }
      // 6. closest field-container's first line of text
      const container = el.closest(
        '[data-test-form-element], .jobs-easy-apply-form-element, [class*="field" i], [class*="question" i], [class*="form-group" i], [class*="_fieldEntry" i], [class*="application-question" i]'
      );
      if (container) {
        const line = textOf(container).split('\n')[0]?.trim();
        if (line) return { label: line.slice(0, 200), source: 'container-firstline' };
      }
      // 7. placeholder as last resort
      const ph = el.getAttribute('placeholder');
      if (ph && ph.trim()) return { label: ph.trim(), source: 'placeholder' };
      return { label: '', source: 'none' };
    }

    // ── stable selector synthesis ─────────────────────────────────────
    function nthPath(el) {
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && node !== document.body && parts.length < 6) {
        let part = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (parent) {
          const sameTag = [...parent.children].filter((c) => c.tagName === node.tagName);
          if (sameTag.length > 1) {
            const idx = sameTag.indexOf(node) + 1;
            part += `:nth-of-type(${idx})`;
          }
        }
        parts.unshift(part);
        if (node.id) { parts[0] = `#${CSS.escape(node.id)}`; break; }
        node = node.parentElement;
      }
      return parts.join(' > ');
    }
    function bestSelector(el) {
      if (el.id) return { selector: `#${CSS.escape(el.id)}`, strategy: 'id' };
      const name = el.getAttribute('name');
      if (name) {
        const tag = el.tagName.toLowerCase();
        const same = document.querySelectorAll(`${tag}[name="${CSS.escape(name)}"]`);
        // [name] is only unique-enough if there's one (or it's a radio group sharing a name)
        if (same.length === 1 || el.type === 'radio' || el.type === 'checkbox') {
          return { selector: `${tag}[name="${name}"]`, strategy: 'name' };
        }
      }
      const dataAttr = ['data-testid', 'data-test', 'data-qa', 'data-automation-id'].find((a) => el.getAttribute(a));
      if (dataAttr) return { selector: `[${dataAttr}="${el.getAttribute(dataAttr)}"]`, strategy: dataAttr };
      return { selector: nthPath(el), strategy: 'nth-path' };
    }

    function isRequired(el) {
      return !!(
        el.required ||
        el.getAttribute('aria-required') === 'true' ||
        el.getAttribute('required') !== null ||
        /\brequired\b|\*/.test(
          (el.closest('label, [class*="field" i], [class*="question" i]')?.getAttribute?.('aria-label') || '') +
          ' ' +
          (el.closest('label, [class*="field" i], [class*="question" i]') ?
            ((el.closest('label, [class*="field" i], [class*="question" i]').querySelector('[class*="required" i], [aria-label*="required" i]')) ? 'required' : '') : '')
        )
      );
    }

    function isVisible(el) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      // radios/checkboxes are often 0x0 with a styled label; still count them
      if (el.type === 'radio' || el.type === 'checkbox') return true;
      return r.width > 0 || r.height > 0;
    }

    // ── scope: whole document + any open dialogs (Easy Apply modal etc.) ─
    const roots = [document];

    const native = [];
    const seen = new Set();

    // Native controls
    document.querySelectorAll('input, textarea, select').forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);
      const type = el.type || (el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName === 'SELECT' ? 'select' : 'text');
      // skip hidden/submit/button machinery from the field inventory
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) return;
      const { label, source } = resolveLabel(el);
      const sel = bestSelector(el);
      const rec = {
        kind: 'native',
        tag: el.tagName.toLowerCase(),
        type,
        label,
        labelSource: source,
        selector: sel.selector,
        selectorStrategy: sel.strategy,
        name: el.getAttribute('name') || null,
        id: el.id || null,
        required: isRequired(el),
        visible: isVisible(el),
        value: (el.type === 'checkbox' || el.type === 'radio') ? (el.checked ? el.value || 'on' : '') : (el.value || ''),
      };
      if (el.type === 'radio' || el.type === 'checkbox') {
        rec.checked = el.checked;
        rec.radioGroup = el.getAttribute('name') || null;
      }
      if (el.tagName === 'SELECT') {
        rec.options = [...el.options].map((o) => ({ text: textOf(o) || o.text, value: o.value })).filter((o) => o.text);
      }
      native.push(rec);
    });

    // ── custom widgets: role=combobox|listbox, [aria-haspopup], div-based selects ─
    const custom = [];
    const customSel = [
      '[role="combobox"]',
      '[role="listbox"]',
      '[aria-haspopup="listbox"]',
      '[aria-haspopup="true"]',
      'button[aria-haspopup]',
      '[class*="select" i]:not(select):not(option):not(optgroup)',
      '[class*="combobox" i]',
      '[class*="dropdown" i]',
    ].join(',');
    document.querySelectorAll(customSel).forEach((el) => {
      if (seen.has(el)) return;
      // ignore if it wraps/contains a native <select> we already captured —
      // the native record is more actionable
      if (el.querySelector('select')) return;
      // ignore tiny chrome (icons, arrows) with no role and no aria
      const role = el.getAttribute('role');
      const hasPopup = el.getAttribute('aria-haspopup');
      const looksLikeSelect = role === 'combobox' || role === 'listbox' || hasPopup ||
        /\b(select|combobox|dropdown)\b/i.test(el.className || '');
      if (!looksLikeSelect) return;
      seen.add(el);
      const { label, source } = resolveLabel(el);
      const sel = bestSelector(el);
      // inner editable input (autocomplete comboboxes wrap a text input)
      const innerInput = el.querySelector('input, [role="textbox"], [contenteditable="true"]');
      // pre-rendered options if any are inline (portal-rendered options won't show
      // until opened — adapters must open then query page-global [role=option])
      const inlineOptions = [...el.querySelectorAll('[role="option"]')]
        .map((o) => textOf(o))
        .filter(Boolean)
        .slice(0, 40);
      custom.push({
        kind: 'custom',
        widget: role || (hasPopup ? 'haspopup' : 'class-select'),
        tag: el.tagName.toLowerCase(),
        role: role || null,
        ariaHaspopup: hasPopup || null,
        ariaExpanded: el.getAttribute('aria-expanded'),
        label,
        labelSource: source,
        selector: sel.selector,
        selectorStrategy: sel.strategy,
        id: el.id || null,
        className: (el.className && typeof el.className === 'string') ? el.className.slice(0, 120) : null,
        required: isRequired(el),
        visible: isVisible(el),
        currentText: textOf(el).split('\n')[0]?.slice(0, 80) || '',
        hasInnerInput: !!innerInput,
        innerInputSelector: innerInput ? bestSelector(innerInput).selector : null,
        inlineOptions,
        note:
          'Options likely render in a detached portal at document root. To enumerate/fill: click this widget to open, then query page-global [role="option"] (do NOT scope under this element). Decline option regex: /decline to (self-identify|answer)|prefer not to (say|answer|disclose)|i don.?t wish to answer|do not wish/i. Never press Enter — it can submit the form.',
      });
    });

    // ── submit button ──────────────────────────────────────────────────
    let submit = null;
    const submitCandidates = [
      ...document.querySelectorAll(
        'input[type="submit"], button[type="submit"], button[aria-label*="submit" i]'
      ),
      ...[...document.querySelectorAll('button, a')].filter((b) =>
        /submit application|submit|apply now|send application/i.test(textOf(b))
      ),
    ];
    for (const b of submitCandidates) {
      if (!b) continue;
      const r = b.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const sel = bestSelector(b);
      submit = {
        tag: b.tagName.toLowerCase(),
        text: (textOf(b) || b.value || b.getAttribute('aria-label') || '').slice(0, 60),
        selector: sel.selector,
        selectorStrategy: sel.strategy,
        disabled: !!b.disabled,
      };
      break;
    }

    // ── radio-group rollup (so adapters see grouped options) ────────────
    const radioGroups = {};
    native
      .filter((f) => f.type === 'radio' && f.radioGroup)
      .forEach((f) => {
        if (!radioGroups[f.radioGroup]) {
          // find the group's legend/label via the first member element
          const member = document.querySelector(`input[type="radio"][name="${CSS.escape(f.radioGroup)}"]`);
          const gl = member ? resolveLabel(member) : { label: '' };
          radioGroups[f.radioGroup] = { name: f.radioGroup, label: gl.label, options: [] };
        }
        radioGroups[f.radioGroup].options.push({ value: f.value || null, label: f.label, checked: !!f.checked });
      });

    // ── page meta / login + captcha flags ──────────────────────────────
    const bodyText = document.body.innerText || '';
    const flags = {
      captcha: /captcha|i.?m not a robot|recaptcha|hcaptcha|cloudflare/i.test(bodyText) ||
        !!document.querySelector('iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], [class*="captcha" i]'),
      loginWall: /sign in|log in to (apply|continue)|please log in/i.test(bodyText) &&
        !!document.querySelector('input[type="password"]'),
    };

    return {
      url: location.href,
      title: document.title,
      counts: {
        native: native.length,
        custom: custom.length,
        radioGroups: Object.keys(radioGroups).length,
      },
      nativeFields: native,
      customWidgets: custom,
      radioGroups: Object.values(radioGroups),
      submit,
      flags,
    };
  });
}

// ─── readable summary printer ──────────────────────────────────────────────

function printSummary(report, outPath, clicked) {
  const line = '─'.repeat(72);
  console.log(`\n${line}`);
  console.log(`FORM INTROSPECTION — ${report.title || report.url}`);
  console.log(`URL:      ${report.url}`);
  if (clicked) console.log(`Apply clicked: "${clicked.label}" via ${clicked.selector}`);
  if (report.flags.captcha) console.log('!! CAPTCHA detected — adapter must STOP and flag (never solve).');
  if (report.flags.loginWall) console.log('!! Login wall detected — session may have expired in .secrets/browser-profile.');
  console.log(line);

  console.log(`Native fields: ${report.counts.native}  |  Custom widgets: ${report.counts.custom}  |  Radio groups: ${report.counts.radioGroups}\n`);

  if (report.nativeFields.length) {
    console.log('NATIVE FIELDS');
    for (const f of report.nativeFields) {
      const req = f.required ? ' *REQ' : '';
      const val = f.value ? `  ="${String(f.value).slice(0, 30)}"` : '';
      const opts = f.options ? `  [${f.options.length} opts]` : '';
      const vis = f.visible ? '' : '  (hidden)';
      console.log(`  • [${f.tag}/${f.type}]${req} ${f.label || '(no label)'}${opts}${val}${vis}`);
      console.log(`      sel: ${f.selector}  (${f.selectorStrategy}, label via ${f.labelSource})`);
    }
    console.log('');
  }

  if (report.customWidgets.length) {
    console.log('CUSTOM WIDGETS (the broken-handler gap — comboboxes/listboxes)');
    for (const w of report.customWidgets) {
      const req = w.required ? ' *REQ' : '';
      const inner = w.hasInnerInput ? '  [has inner input]' : '';
      const inline = w.inlineOptions.length ? `  [${w.inlineOptions.length} inline opts]` : '';
      console.log(`  ◆ [${w.widget}]${req} ${w.label || '(no label)'}${inner}${inline}`);
      console.log(`      sel: ${w.selector}  (${w.selectorStrategy}, label via ${w.labelSource})`);
      if (w.currentText) console.log(`      current: "${w.currentText}"`);
    }
    console.log('');
  }

  if (report.radioGroups.length) {
    console.log('RADIO GROUPS');
    for (const g of report.radioGroups) {
      const checked = g.options.find((o) => o.checked);
      console.log(`  ○ ${g.label || g.name}${checked ? ` (= "${checked.label}")` : ''}`);
      console.log(`      options: ${g.options.map((o) => o.label).filter(Boolean).join(' | ')}`);
    }
    console.log('');
  }

  if (report.submit) {
    console.log(`SUBMIT BUTTON: [${report.submit.tag}] "${report.submit.text}"  →  ${report.submit.selector}${report.submit.disabled ? '  (disabled)' : ''}`);
  } else {
    console.log('SUBMIT BUTTON: not found (form may be multi-step — re-run after advancing).');
  }

  console.log(`${line}`);
  console.log(`Full inventory → ${outPath}`);
  console.log(`${line}\n`);
}

// ─── Main ────────────────────────────────────────────────────────────────

export async function introspectUrl(url) {
  ensureLogDir();
  const browser = await makeContext();
  const page = await browser.newPage();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = join(LOG_DIR, `introspect-${hostSlug(url)}-${stamp}.json`);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
    await page.waitForTimeout(1800);

    const clicked = await clickApplyIfNeeded(page);

    // Wait for the form to materialize (modal animation, lazy ATS bundle, etc.)
    await page.waitForFunction(() => {
      const sel = 'input[type="file"], input[type="email"], textarea, [role="combobox"], [data-test-form-element], [class*="application-form" i]';
      return document.querySelectorAll(sel).length > 0 || document.querySelectorAll('input[type="text"], input:not([type])').length >= 3;
    }, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);

    const report = await introspect(page);
    report.meta = {
      requestedUrl: url,
      capturedAt: new Date().toISOString(),
      appliedTrigger: clicked,
      headless: process.env.HEADLESS !== 'false',
      profile: '.secrets/browser-profile (shared logged-in)',
    };

    await writeFile(outPath, JSON.stringify(report, null, 2), 'utf-8');
    printSummary(report, outPath, clicked);
    return { ok: true, outPath, report };
  } catch (err) {
    const failPath = outPath.replace(/\.json$/, '-ERROR.json');
    const payload = {
      ok: false,
      requestedUrl: url,
      error: err.message.split('\n')[0],
      capturedAt: new Date().toISOString(),
    };
    await writeFile(failPath, JSON.stringify(payload, null, 2), 'utf-8').catch(() => {});
    console.error(`[introspect] FAILED: ${payload.error}`);
    console.error(`[introspect] partial log → ${failPath}`);
    return { ok: false, outPath: failPath, error: payload.error };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.argv[2];
  if (!url || /^--/.test(url)) {
    console.error('Usage: node daemon/introspect-form.mjs <url>');
    console.error('       HEADLESS=false node daemon/introspect-form.mjs <url>   # watch the browser');
    process.exit(1);
  }
  const result = await introspectUrl(url);
  process.exit(result.ok ? 0 : 1);
}
