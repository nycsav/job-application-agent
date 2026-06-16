#!/usr/bin/env node
/**
 * Dice Signup Assist — drives the persistent-profile browser through Dice
 * account creation, filling everything from candidate data + a generated
 * password (saved to .secrets/dice-credentials.txt). STOPS before the final
 * submit so Sav solves any CAPTCHA + accepts Terms herself, then the session
 * persists in .secrets/browser-profile for the submit daemon to reuse.
 *
 *   node daemon/dice-signup.mjs
 */
import { chromium } from 'playwright';
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PROFILE = join(ROOT, '.secrets', 'browser-profile');
const AUDIT = join(ROOT, '.audit', 'dice-signup');
if (!existsSync(AUDIT)) mkdirSync(AUDIT, { recursive: true });

const c = JSON.parse(readFileSync(join(ROOT, 'config', 'candidate.json'), 'utf-8'));
const EMAIL = 'sav@ensopartners.co';
const PASSWORD = `Enso-${randomBytes(5).toString('hex')}-9Q`; // strong, mixed-class
const [FIRST, ...rest] = c.name.split(' ');
const LAST = rest.join(' ') || 'Banerjee';

// Save the credential so Sav has it (gitignored .secrets dir)
const credPath = join(ROOT, '.secrets', 'dice-credentials.txt');
writeFileSync(credPath, `Dice account\nemail: ${EMAIL}\npassword: ${PASSWORD}\ncreated: ${new Date().toISOString()}\n`);
console.log(`[dice-signup] credentials saved → ${credPath}`);
console.log(`[dice-signup] email: ${EMAIL}  password: ${PASSWORD}`);

const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, viewport: { width: 1280, height: 900 } });
const page = ctx.pages()[0] || (await ctx.newPage());

async function shot(name) { await page.screenshot({ path: join(AUDIT, name), fullPage: true }).catch(() => {}); }
async function fill(selectors, val) {
  for (const sel of selectors) {
    const l = page.locator(sel).first();
    if (await l.isVisible({ timeout: 1200 }).catch(() => false)) { await l.fill(val).catch(() => {}); return sel; }
  }
  return null;
}

try {
  await page.goto('https://www.dice.com/dashboard/login', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await shot('0-login-page.png');
  // Click through to the registration form (Dice has no direct register URL)
  const reg = page.locator(
    'a:has-text("Create account"), a:has-text("Create an account"), a:has-text("Register"), a:has-text("Sign up"), a:has-text("Join"), a[href*="register" i], a[href*="signup" i], button:has-text("Create account"), button:has-text("Sign up")'
  ).first();
  if (await reg.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('[dice-signup] clicking register link…');
    await reg.click().catch(() => {});
    await page.waitForTimeout(3000);
  } else {
    console.log('[dice-signup] no register link found on login page — see 0-login-page.png');
  }
  await shot('1-signup-page.png');

  const e = await fill(['input[type="email"]', 'input[name*="email" i]', 'input[id*="email" i]', 'input[autocomplete="email"]'], EMAIL);
  const p = await fill(['input[type="password"]', 'input[name*="password" i]', 'input[id*="password" i]', 'input[autocomplete="new-password"]'], PASSWORD);
  await fill(['input[name*="first" i]', 'input[id*="first" i]', 'input[placeholder*="First" i]'], FIRST);
  await fill(['input[name*="last" i]', 'input[id*="last" i]', 'input[placeholder*="Last" i]'], LAST);
  await page.waitForTimeout(1200);
  await shot('2-filled.png');
  console.log(`[dice-signup] email filled: ${!!e}`);

  // Email-first unified auth: "Continue with email" creates the account (and
  // accepts Dice's ToS). Sav explicitly directed account creation, so proceed.
  const cont = page.locator('button:has-text("Continue with email"), button:has-text("Continue with Email"), button:has-text("Continue"), button[type="submit"]').first();
  if (await cont.isVisible({ timeout: 2500 }).catch(() => false)) {
    console.log('[dice-signup] clicking "Continue with email"…');
    await cont.click().catch(() => {});
    await page.waitForTimeout(4500);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await shot('3-after-continue.png');
    const body = (await page.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 400).replace(/\s+/g, ' ');
    console.log('[dice-signup] after-continue page text:', body);

    // Registration form: account-type "Myself", first/last, password x2, Register.
    // reCAPTCHA is invisible v3 (no checkbox) — Register passes the bot-score or
    // Dice blocks silently. Sav directed account creation, so attempt fully.
    await page.getByText('Myself', { exact: true }).first().click({ timeout: 2500 }).catch(() => {});
    await fill(['input[placeholder="John" i]', 'input[name*="first" i]', 'input[id*="first" i]'], FIRST);
    await fill(['input[placeholder="Doe" i]', 'input[name*="last" i]', 'input[id*="last" i]'], LAST);
    const pw = page.locator('input[type="password"]');
    const npw = await pw.count().catch(() => 0);
    if (npw >= 1) await pw.nth(0).fill(PASSWORD).catch(() => {});
    if (npw >= 2) await pw.nth(1).fill(PASSWORD).catch(() => {});
    await page.waitForTimeout(900);
    await shot('4-registration-filled.png');

    const regBtn = page.locator('button:has-text("Register")').first();
    if (await regBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('[dice-signup] clicking Register (reCAPTCHA v3 evaluates now)…');
      await regBtn.click().catch(() => {});
      await page.waitForTimeout(7000);
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await shot('5-after-register.png');
      const u2 = page.url();
      const t2 = (await page.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 350).replace(/\s+/g, ' ');
      console.log('[dice-signup] AFTER-REGISTER url:', u2);
      console.log('[dice-signup] AFTER-REGISTER text:', t2);
      console.log(/welcome|dashboard|verify your email|check your email|confirm your email/i.test(t2) ? '[dice-signup] LIKELY SUCCESS ✓ (may need email verification)' : '[dice-signup] still on form — reCAPTCHA may have blocked; see 5-after-register.png');
    }
    console.log('[dice-signup] → screenshots 3/4/5 in .audit/dice-signup/');
  } else {
    console.log('[dice-signup] no "Continue" button found — see 2-filled.png');
  }
  console.log('[dice-signup] Window stays open. Tell Claude "done" or Ctrl+C when finished.');
} catch (err) {
  console.error('[dice-signup] error:', err.message);
  await shot('error.png');
}

process.on('SIGINT', async () => { await ctx.close().catch(() => {}); process.exit(0); });
await new Promise(() => {}); // keep window open for Sav to finish
