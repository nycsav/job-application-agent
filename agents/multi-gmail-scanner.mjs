#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildJobSearchQueries, getGmailClientForAccount, loadGmailAccounts } from '../lib/gmail-accounts.mjs';
import { DEFAULT_JOB_APPLICATION_LABEL, moveMessageToGmailLabel } from '../lib/gmail-labels.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

export async function scanAllGmailAccounts({
  root = ROOT,
  hours = 24,
  maxResults = 25,
  archiveProcessed = false,
  processedLabel = DEFAULT_JOB_APPLICATION_LABEL
} = {}) {
  const accounts = await loadGmailAccounts({ root });
  const queries = buildJobSearchQueries({ hours, processedLabel });
  const findings = [];
  const errors = [];
  const archivedMessages = [];

  for (const account of accounts) {
    let gmail;
    try {
      gmail = await getGmailClientForAccount(account, { root });
    } catch (err) {
      errors.push({ account: account.id, email: account.email, error: err.message });
      continue;
    }

    const seen = new Set();
    for (const query of queries) {
      try {
        const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults });
        for (const msg of res.data.messages || []) {
          if (seen.has(msg.id)) continue;
          seen.add(msg.id);
          const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
          const headers = full.data.payload?.headers || [];
          const subject = header(headers, 'Subject');
          const from = header(headers, 'From');
          const date = header(headers, 'Date');
          const body = extractBody(full.data.payload || {});
          const roles = extractRoles({ subject, from, date, body, account, message: msg });
          findings.push(...roles);

          if (archiveProcessed && roles.length) {
            try {
              await moveMessageToGmailLabel(gmail, msg.id, processedLabel);
              archivedMessages.push({
                account: account.id,
                email: account.email,
                messageId: msg.id,
                threadId: msg.threadId,
                label: processedLabel,
                roles: roles.map((role) => ({ company: role.company, title: role.title }))
              });
            } catch (err) {
              errors.push({
                account: account.id,
                email: account.email,
                messageId: msg.id,
                action: 'archiveProcessed',
                error: err.message
              });
            }
          }
        }
      } catch (err) {
        errors.push({ account: account.id, email: account.email, query, error: err.message });
      }
    }
  }

  return { findings, errors, archivedMessages };
}

export async function writeFindingsToInput(result, { root = ROOT } = {}) {
  const inputDir = path.join(root, 'input');
  await mkdir(inputDir, { recursive: true });
  const out = path.join(inputDir, 'saved-jobs.json');
  await writeFile(out, JSON.stringify({
    roles: result.findings,
    errors: result.errors,
    archivedMessages: result.archivedMessages || [],
    generatedAt: new Date().toISOString()
  }, null, 2));
  return out;
}

function extractRoles({ subject, from, date, body, account, message }) {
  const roles = [];
  const text = `${subject}\n${body}`;
  const linkedIn = /([A-Z][^\n|•]{4,80})\s+at\s+([A-Z][A-Za-z0-9&.,' -]{2,60})/g;
  let match;
  while ((match = linkedIn.exec(text)) !== null) {
    roles.push(baseRole({ title: match[1], company: match[2], subject, from, date, body, account }));
  }

  if (!roles.length && /(recruiter|talent|hiring|opportunity|role|position|job)/i.test(`${from} ${subject}`)) {
    roles.push(baseRole({
      title: inferTitle(subject, body),
      company: inferCompany(body),
      subject,
      from,
      date,
      body,
      account
    }));
  }

  return dedupeRoles(roles);
}

function baseRole({ title, company, subject, from, date, body, account }) {
  return {
    title: clean(title),
    company: clean(company || 'Unknown'),
    location: inferLocation(body),
    salary: inferSalary(body),
    description: clean(body).slice(0, 1200),
    source: `gmail:${account.id}`,
    sourceEmail: account.email,
    sourceSender: from,
    sourceSubject: subject,
    sourceDate: date,
    gmailMessageId: message?.id || '',
    gmailThreadId: message?.threadId || ''
  };
}

function dedupeRoles(roles) {
  const seen = new Set();
  return roles.filter((role) => {
    const key = `${role.company}|${role.title}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inferTitle(subject, body) {
  return clean(subject.match(/(?:role|position|opportunity|opening)[: -]+(.+)/i)?.[1] || subject).slice(0, 90);
}

function inferCompany(body) {
  return clean(body.match(/(?:at|with|for)\s+([A-Z][A-Za-z0-9&.,' -]{2,60})(?:[.,\n]| is | has | seeks )/)?.[1] || 'Unknown');
}

function inferLocation(body) {
  return clean(body.match(/\b(Remote|Hybrid|New York|NYC|United States|San Francisco|Boston|Chicago)\b/i)?.[1] || '');
}

function inferSalary(body) {
  return clean(body.match(/\$[\d,.]+ ?(?:K|k)?(?:\s*[-–]\s*\$?[\d,.]+ ?(?:K|k)?)?(?:\/yr| per year|\/hr| per hour)?/i)?.[0] || '');
}

function header(headers, name) {
  return headers.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value || '';
}

function extractBody(payload) {
  if (payload.body?.data) return decode(payload.body.data);
  for (const part of payload.parts || []) {
    if (part.mimeType === 'text/plain' && part.body?.data) return decode(part.body.data);
  }
  for (const part of payload.parts || []) {
    if (part.mimeType === 'text/html' && part.body?.data) return decode(part.body.data).replace(/<[^>]+>/g, ' ');
  }
  for (const part of payload.parts || []) {
    if (part.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }
  return '';
}

function decode(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseArgs(argv) {
  const out = { hours: 24, archiveProcessed: false, processedLabel: DEFAULT_JOB_APPLICATION_LABEL };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--hours') out.hours = Number(argv[++i]);
    if (argv[i] === '--write-input') out.writeInput = true;
    if (argv[i] === '--archive-processed') out.archiveProcessed = true;
    if (argv[i] === '--no-archive-processed') out.archiveProcessed = false;
    if (argv[i] === '--processed-label') out.processedLabel = argv[++i];
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const result = await scanAllGmailAccounts({
    hours: args.hours,
    archiveProcessed: args.archiveProcessed,
    processedLabel: args.processedLabel
  });
  if (args.writeInput) {
    const out = await writeFindingsToInput(result);
    console.error(`Wrote ${result.findings.length} findings to ${out}`);
  }
  if (args.archiveProcessed) {
    console.error(`Moved ${result.archivedMessages.length} processed Gmail messages to "${args.processedLabel}"`);
  }
  console.log(JSON.stringify(result, null, 2));
}
