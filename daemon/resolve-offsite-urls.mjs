#!/usr/bin/env node
/**
 * Resolve Off-Site URLs — for queue roles whose Job URL is a linkedin.com
 * posting with a decorative Easy Apply badge ("Responses managed off LinkedIn"),
 * click the external Apply button, capture the real ATS URL, and write it back
 * to the Notion Job URL property. NO form filling, NO submission — read-only
 * browsing + a Notion URL update, so the next submit-ready run can route the
 * role to the right platform adapter (or give Sav the true link for manual).
 *
 * Run: node daemon/resolve-offsite-urls.mjs [--limit 15] [--dry-run]
 */

import { chromium } from 'playwright';
import { readFile, writeFile } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const NOTION_DB_ID = '8ce2a0e3-0ab3-4416-bcfe-81295f4e4991';
const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

function cliArg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) return true;
  return v;
}
const LIMIT = Number(cliArg('limit', 20));
const DRY = cliArg('dry-run', false) === true;

async function loadNotionKey() {
  if (process.env.NOTION_API_KEY) return process.env.NOTION_API_KEY;
  const p = join(ROOT, '.secrets', 'notion-token.txt');
  if (existsSync(p)) return (await readFile(p, 'utf-8')).trim();
  throw new Error('Notion key not found');
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
  if (!res.ok) throw new Error(`Notion ${method} ${endpoint} → ${res.status}: ${json.message}`);
  return json;
}

async function queryLinkedInQueue(key) {
  const pages = [];
  let cursor;
  do {
    const body = {
      filter: {
        or: [
          { property: 'Status', select: { equals: 'Materials Ready' } },
          { property: 'Status', select: { equals: 'Approved' } },
        ],
      },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    };
    const r = await notionFetch('POST', `/databases/${NOTION_DB_ID}/query`, body, key);
    pages.push(...(r.results || []));
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return pages
    .map(p => {
      const pr = p.properties || {};
      const t = (x) => x?.title?.map(t => t.plain_text).join('') || x?.rich_text?.map(t => t.plain_text).join('') || '';
      return {
        page_id: p.id,
        title: t(pr['Job Title']),
        company: t(pr['Company']),
        url: pr['Job URL']?.url || '',
      };
    })
    .filter(r => /linkedin\.com\/jobs/i.test(r.url));
}

function detectPlatform(url) {
  if (!url) return 'unknown';
  if (/greenhouse\.io/i.test(url)) return 'greenhouse';
  if (/ashbyhq\.com/i.test(url)) return 'ashby';
  if (/jobs\.lever\.co/i.test(url)) return 'lever';
  if (/myworkdayjobs\.com|workday\.com/i.test(url)) return 'workday';
  if (/icims\.com/i.test(url)) return 'icims';
  if (/linkedin\.com/i.test(url)) return 'linkedin';
  return 'external';
}

async function main() {
  const key = await loadNotionKey();
  const queue = (await queryLinkedInQueue(key)).slice(0, LIMIT);
  console.log(`[resolve] ${queue.length} LinkedIn-URL role(s) in queue`);
  if (!queue.length) return;

  const browser = await chromium.launchPersistentContext(
    join(ROOT, '.secrets', 'browser-profile'),
    { headless: process.env.HEADLESS !== 'false', viewport: { width: 1280, height: 900 } }
  );

  const results = [];
  for (const role of queue) {
    const label = `${role.title} @ ${role.company}`;
    console.log(`\n[resolve] → ${label}`);
    const page = await browser.newPage();
    try {
      await page.goto(role.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(2000);

      const body = await page.evaluate(() => document.body.innerText);
      if (/application submitted|applied \d/i.test(body)) {
        console.log('[resolve]   already submitted on LinkedIn — leaving as-is');
        results.push({ ...role, resolved: null, note: 'already submitted' });
        continue;
      }

      // The apply button (external or Easy Apply — for off-site jobs the click
      // opens the employer portal in a new tab; for true Easy Apply a modal
      // opens and we just close it without touching the form).
      const applyBtn = page.locator(
        'button:has-text("Apply"), a:has-text("Apply"), a[aria-label*="Apply" i], button[aria-label*="Apply" i]'
      ).first();
      if (!(await applyBtn.isVisible({ timeout: 6000 }).catch(() => false))) {
        console.log('[resolve]   no Apply button found');
        results.push({ ...role, resolved: null, note: 'no apply button' });
        continue;
      }

      const popupPromise = browser.waitForEvent('page', { timeout: 12000 }).catch(() => null);
      await applyBtn.click({ timeout: 8000 });
      const popup = await popupPromise;

      let resolved = null;
      if (popup) {
        await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await popup.waitForTimeout(3500); // let redirect chains settle
        resolved = popup.url();
        await popup.close().catch(() => {});
      } else {
        // No popup: either a modal opened (true Easy Apply) or same-tab nav
        await page.waitForTimeout(2500);
        const modal = await page.locator('[role="dialog"]').first().isVisible({ timeout: 1500 }).catch(() => false);
        if (modal) {
          console.log('[resolve]   true Easy Apply modal — keeping LinkedIn URL');
          await page.locator('button[aria-label="Dismiss"]').first().click().catch(() => {});
          results.push({ ...role, resolved: null, note: 'true easy apply' });
          continue;
        }
        const nav = page.url();
        if (!/linkedin\.com/i.test(nav)) resolved = nav;
      }

      const resolvedHost = (() => { try { return new URL(resolved || '').hostname; } catch { return ''; } })();
      if (!resolved || !/^https?:\/\//i.test(resolved) || /(^|\.)linkedin\.com$/i.test(resolvedHost)) {
        console.log(`[resolve]   could not capture external URL (got: ${resolved || 'nothing'})`);
        results.push({ ...role, resolved: null, note: 'no external url captured' });
        continue;
      }

      const platform = detectPlatform(resolved);
      console.log(`[resolve]   ✓ ${platform}: ${resolved.slice(0, 110)}`);
      if (!DRY) {
        await notionFetch('PATCH', `/pages/${role.page_id}`, {
          properties: { 'Job URL': { url: resolved.slice(0, 1900) } },
        }, key);
      }
      results.push({ ...role, resolved, platform });
    } catch (err) {
      console.log(`[resolve]   ERROR: ${err.message.split('\n')[0]}`);
      results.push({ ...role, resolved: null, note: err.message.split('\n')[0] });
    } finally {
      await page.close().catch(() => {});
    }
  }

  await browser.close().catch(() => {});

  const ok = results.filter(r => r.resolved);
  const byPlatform = {};
  ok.forEach(r => { byPlatform[r.platform] = (byPlatform[r.platform] || 0) + 1; });
  console.log(`\n[resolve] Done: ${ok.length}/${results.length} resolved → ${JSON.stringify(byPlatform)}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await writeFile(join(ROOT, '.logs', `resolve-${stamp}.json`), JSON.stringify(results, null, 2));
}

main().catch(err => { console.error('[resolve] fatal:', err); process.exit(1); });
