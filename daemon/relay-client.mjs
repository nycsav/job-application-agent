#!/usr/bin/env node
/**
 * Relay Client — wraps the Apps Script Gmail Relay endpoint.
 *
 * The relay handles 6 actions:
 *   scan_gmail, clean_confirmations, append_row, update_row, check_duplicate, read_rows
 *
 * Daemon-side (Node) auth note: the Apps Script Web App is deployed with
 * "Anyone with Google account" access, which means anonymous fetch returns
 * Google's "Page Not Found" stub. For daemon use, deploy a SECONDARY copy
 * with "Anyone, even anonymous" OR run the daemon under a Google session
 * via OAuth (see lib/gmail-auth.mjs).
 *
 * Simplest path: set RELAY_BEARER in `.env` to a shared-secret string and
 * add a matching check inside doPost. This module sends it automatically.
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PIPELINE_CONFIG = join(__dirname, '..', 'config', 'pipeline.json');

let _config = null;

async function getConfig() {
  if (_config) return _config;
  const raw = await readFile(PIPELINE_CONFIG, 'utf-8');
  _config = JSON.parse(raw);
  return _config;
}

async function call(action, payload = {}) {
  const config = await getConfig();
  const url = config.sheets_webhook_url;
  if (!url) throw new Error('config/pipeline.json missing sheets_webhook_url');

  const body = { action, ...payload };
  if (process.env.RELAY_BEARER) body._auth = process.env.RELAY_BEARER;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'follow',
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Relay non-JSON response (${res.status}): ${text.slice(0, 300)}`);
  }
}

// ─── Public actions ─────────────────────────────────────────────

export const scanGmail = (hours = 12, queries = null, maxThreads = 100) =>
  call('scan_gmail', { hours, max_threads: maxThreads, ...(queries ? { queries } : {}) });

export const cleanConfirmations = (hours = 48, dryRun = false) =>
  call('clean_confirmations', { hours, dry_run: dryRun });

export const appendRow = (row) => call('append_row', { row });

export const updateRow = (match, updates) => call('update_row', { match, updates });

export const checkDuplicate = (company, jobTitle) =>
  call('check_duplicate', { company, job_title: jobTitle });

export const readRows = () => call('read_rows');

// ─── Convenience: extract LinkedIn job IDs from a scan result ──

export function extractLinkedInIds(scanResult) {
  const ids = new Set();
  const threadsById = new Map();
  for (const thread of scanResult.threads || []) {
    const urlBlob = (thread.urls || []).join(' ') + ' ' + (thread.body || '');
    const matches = urlBlob.match(/jobs\/view\/(\d+)/g) || [];
    for (const m of matches) {
      const id = m.match(/\d+/)[0];
      ids.add(id);
      if (!threadsById.has(id)) threadsById.set(id, thread);
    }
  }
  return { ids: [...ids], threadsById };
}

// CLI: smoke-test
if (import.meta.url === `file://${process.argv[1]}`) {
  const action = process.argv[2];
  if (!action) {
    console.error('Usage: node relay-client.mjs <scan|clean|read|dedupe> [args]');
    process.exit(1);
  }
  const result = await (
    action === 'scan' ? scanGmail(Number(process.argv[3] || 12)) :
    action === 'clean' ? cleanConfirmations(Number(process.argv[3] || 48), true) :
    action === 'read' ? readRows() :
    action === 'dedupe' ? checkDuplicate(process.argv[3], process.argv[4]) :
    Promise.reject(new Error('unknown action'))
  );
  console.log(JSON.stringify(result, null, 2));
}
