#!/usr/bin/env node
/**
 * Gmail OAuth2 Setup — One-time auth flow for sav.banerjee@gmail.com
 *
 * Usage:
 *   1. Create OAuth2 credentials at console.cloud.google.com
 *   2. Download credentials.json to config/gmail-credentials.json
 *   3. Run: node lib/gmail-auth.mjs
 *   4. Open the URL in browser, sign in with sav.banerjee@gmail.com
 *   5. Paste the auth code back into the terminal
 *   6. Token saved to config/gmail-token.json (refresh token persists)
 *
 * After setup, agents/personal-gmail-scanner.mjs uses the saved token.
 */

import { google } from 'googleapis';
import { readFile, writeFile } from 'fs/promises';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CREDENTIALS_PATH = join(ROOT, 'config', 'gmail-credentials.json');
const TOKEN_PATH = join(ROOT, 'config', 'gmail-token.json');

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

/**
 * Load saved token and return an authenticated Gmail client.
 * Called by the scanner — no user interaction needed after initial setup.
 */
export async function getGmailClient() {
  const creds = JSON.parse(await readFile(CREDENTIALS_PATH, 'utf8'));
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
  const oAuth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  try {
    const token = JSON.parse(await readFile(TOKEN_PATH, 'utf8'));
    oAuth2.setCredentials(token);

    // Auto-refresh if expired
    oAuth2.on('tokens', async (newTokens) => {
      const existing = JSON.parse(await readFile(TOKEN_PATH, 'utf8'));
      const merged = { ...existing, ...newTokens };
      await writeFile(TOKEN_PATH, JSON.stringify(merged, null, 2));
    });

    return google.gmail({ version: 'v1', auth: oAuth2 });
  } catch {
    throw new Error(
      'No saved token found. Run `node lib/gmail-auth.mjs` first to complete OAuth setup.'
    );
  }
}

/**
 * Interactive setup — run once to get the refresh token.
 */
async function setup() {
  let creds;
  try {
    creds = JSON.parse(await readFile(CREDENTIALS_PATH, 'utf8'));
  } catch {
    console.error(`\n❌ Missing credentials file at:\n   ${CREDENTIALS_PATH}\n`);
    console.error('To create it:');
    console.error('  1. Go to https://console.cloud.google.com/apis/credentials');
    console.error('  2. Create a project (or use existing)');
    console.error('  3. Enable the Gmail API');
    console.error('  4. Create OAuth2 credentials (Desktop app type)');
    console.error('  5. Download JSON → save as config/gmail-credentials.json');
    process.exit(1);
  }

  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
  const oAuth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  const authUrl = oAuth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',  // Force refresh token
    login_hint: 'sav.banerjee@gmail.com',
  });

  console.log('\n🔐 Gmail OAuth2 Setup for sav.banerjee@gmail.com');
  console.log('━'.repeat(50));
  console.log('\nOpen this URL in your browser:\n');
  console.log(authUrl);
  console.log('\nSign in with sav.banerjee@gmail.com, then paste the code below.\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const code = await new Promise((resolve) => {
    rl.question('Authorization code: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  const { tokens } = await oAuth2.getToken(code);
  await writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2));

  console.log(`\n✅ Token saved to ${TOKEN_PATH}`);
  console.log('   The personal Gmail scanner is now ready to use.');
  console.log('   Run: node agents/personal-gmail-scanner.mjs\n');
}

// Run setup if invoked directly
const isMain = process.argv[1] && fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/.*\//, ''));
if (isMain || process.argv[1]?.endsWith('gmail-auth.mjs')) {
  setup().catch(console.error);
}
