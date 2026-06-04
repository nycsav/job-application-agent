#!/usr/bin/env node
/**
 * Sheet Writer — HTTP client for the Apps Script doPost endpoint
 *
 * Replaces the broken googleapis approach with a simple webhook.
 * The Apps Script Web App handles auth (runs as the sheet owner).
 *
 * Usage:
 *   import { appendRow, updateRow, checkDuplicate, readRows } from './sheet-writer.mjs';
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config', 'pipeline.json');

let _config = null;

async function getConfig() {
  if (!_config) {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    _config = JSON.parse(raw);
  }
  return _config;
}

async function callEndpoint(payload) {
  const config = await getConfig();
  const url = config.sheets_webhook_url;

  if (!url || url.includes('PASTE_')) {
    throw new Error(
      'Apps Script Web App URL not configured. ' +
      'Deploy the doPost endpoint and paste the URL into config/pipeline.json'
    );
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'follow'  // Apps Script redirects on deploy
  });

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from Apps Script: ${text.slice(0, 200)}`);
  }
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Append a new row to the sheet.
 * Automatically checks for duplicates (server-side).
 */
export async function appendRow(rowData) {
  return callEndpoint({ action: 'append_row', row: rowData });
}

/**
 * Update an existing row by company + title match.
 * @param {object} match - { company, title }
 * @param {object} updates - fields to update (e.g., { status: 'Applied', applied_date: '2026-05-18' })
 */
export async function updateRow(match, updates) {
  return callEndpoint({ action: 'update_row', match, updates });
}

/**
 * Check if a company+title combo already exists.
 * @returns {{ is_duplicate: boolean, row: number|null, status: string|null }}
 */
export async function checkDuplicate(company, title) {
  return callEndpoint({ action: 'check_duplicate', company, title });
}

/**
 * Read all rows from the sheet (for bulk dedup checks).
 * @returns {{ rows: object[], count: number }}
 */
export async function readRows() {
  return callEndpoint({ action: 'read_rows' });
}

// ─── CLI test ───────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const action = process.argv[2] || 'health';

  if (action === 'health') {
    const config = await getConfig();
    const url = config.sheets_webhook_url;
    if (!url || url.includes('PASTE_')) {
      console.log('❌ Web App URL not configured in config/pipeline.json');
      process.exit(1);
    }
    const resp = await fetch(url);
    const data = await resp.json();
    console.log('✅ Health check:', data);
  } else if (action === 'read') {
    const result = await readRows();
    console.log(`📊 ${result.count} rows in sheet`);
    result.rows?.slice(0, 3).forEach(r => console.log(`  - ${r.job_title} @ ${r.company} [${r.status}]`));
  } else if (action === 'check') {
    const company = process.argv[3];
    const title = process.argv[4];
    if (!company || !title) { console.log('Usage: node sheet-writer.mjs check <company> <title>'); process.exit(1); }
    const result = await checkDuplicate(company, title);
    console.log(result.is_duplicate ? `⚠️  Duplicate: row ${result.row}` : '✅ Not a duplicate');
  }
}
