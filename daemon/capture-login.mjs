#!/usr/bin/env node
/**
 * Capture Login — opens the shared persistent browser profile to a URL so Sav
 * can sign in once by hand. Cookies/session persist in .secrets/browser-profile
 * alongside the LinkedIn session, so the submit daemons reuse the logged-in
 * state on later headless runs. NO automation here — just a visible window held
 * open until Sav presses Ctrl+C.
 *
 * Usage:
 *   node daemon/capture-login.mjs dice          # → https://www.dice.com/dashboard/login
 *   node daemon/capture-login.mjs <full-url>    # any site / Workday tenant login
 *
 * After signing in, leave the window a few seconds (so cookies flush), then Ctrl+C.
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const PROFILE_DIR = join(REPO_ROOT, '.secrets', 'browser-profile');

const SHORTCUTS = {
  dice: 'https://www.dice.com/dashboard/login',
  linkedin: 'https://www.linkedin.com/login',
  indeed: 'https://secure.indeed.com/account/login',
};

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node daemon/capture-login.mjs <dice|linkedin|indeed|full-url>');
  process.exit(1);
}
const url = SHORTCUTS[arg] || (/^https?:\/\//.test(arg) ? arg : `https://${arg}`);

if (!existsSync(join(REPO_ROOT, '.secrets'))) mkdirSync(join(REPO_ROOT, '.secrets'), { recursive: true });

const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: { width: 1280, height: 900 },
});
const page = browser.pages()[0] || (await browser.newPage());
await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});

console.log(`\n  Opened: ${url}`);
console.log('  Sign in in the browser window. When the dashboard loads, wait ~3s,');
console.log('  then press Ctrl+C here — your session is saved to the shared profile.\n');

process.on('SIGINT', async () => {
  await browser.close().catch(() => {});
  console.log('\n  Session saved. You can close this terminal.');
  process.exit(0);
});

await new Promise(() => {}); // hold the window open
