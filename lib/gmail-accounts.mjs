import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_JOB_APPLICATION_LABEL, gmailLabelSearchTerm } from './gmail-labels.mjs';

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

export async function loadGmailAccounts({ root = process.cwd(), configPath = 'config/gmail-accounts.json' } = {}) {
  const file = path.resolve(root, configPath);
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  return (parsed.accounts || []).filter((account) => account.enabled !== false);
}

export async function getGmailClientForAccount(account, { root = process.cwd() } = {}) {
  const { google } = await import('googleapis');
  const credentialsPath = path.resolve(root, account.credentialsPath);
  const tokenPath = path.resolve(root, account.tokenPath);
  const creds = JSON.parse(await readFile(credentialsPath, 'utf8'));
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
  const oAuth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  const token = JSON.parse(await readFile(tokenPath, 'utf8'));
  oAuth2.setCredentials(token);
  oAuth2.on('tokens', async (newTokens) => {
    const existing = JSON.parse(await readFile(tokenPath, 'utf8'));
    await mkdir(path.dirname(tokenPath), { recursive: true });
    await writeFile(tokenPath, JSON.stringify({ ...existing, ...newTokens }, null, 2));
  });
  return google.gmail({ version: 'v1', auth: oAuth2 });
}

export async function buildAuthUrlForAccount(account, { root = process.cwd() } = {}) {
  const { google } = await import('googleapis');
  const credentialsPath = path.resolve(root, account.credentialsPath);
  const creds = JSON.parse(await readFile(credentialsPath, 'utf8'));
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
  const oAuth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  return oAuth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    login_hint: account.email
  });
}

export async function saveAuthCodeForAccount(account, code, { root = process.cwd() } = {}) {
  const { google } = await import('googleapis');
  const credentialsPath = path.resolve(root, account.credentialsPath);
  const tokenPath = path.resolve(root, account.tokenPath);
  const creds = JSON.parse(await readFile(credentialsPath, 'utf8'));
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
  const oAuth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  const { tokens } = await oAuth2.getToken(code);
  await mkdir(path.dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, JSON.stringify(tokens, null, 2));
  return tokenPath;
}

export function buildJobSearchQueries({ hours = 24, processedLabel = DEFAULT_JOB_APPLICATION_LABEL } = {}) {
  const time = `newer_than:${hours}h`;
  const unprocessed = gmailLabelSearchTerm(processedLabel);
  return [
    `from:(linkedin.com OR indeed.com OR my.theladders.com OR jobright.com OR dice.com OR ziprecruiter.com) ${time} ${unprocessed}`,
    `subject:(job alert OR jobs for you OR job recommendation OR role match OR career opportunity) ${time} ${unprocessed}`,
    `subject:(VP AI OR Director AI OR Head of AI OR AI transformation OR enterprise AI strategy) ${time} ${unprocessed}`,
    `subject:(AI Strategy OR AI Advisory OR AI Consulting OR Management Consulting AI OR Digital Strategy) ${time} ${unprocessed}`,
    `from:(recruiter OR talent OR hiring OR staffing OR headhunter OR search) subject:(AI OR opportunity OR role OR position OR candidate) ${time} ${unprocessed}`,
    `subject:(reaching out OR exciting opportunity OR perfect fit OR open role) (AI OR strategy OR director OR VP) ${time} ${unprocessed}`
  ];
}
