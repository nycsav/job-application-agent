import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Saved-job source seam.
 *
 * Today this consumes local exports in input/saved-jobs.json or input/saved-jobs.csv.
 * The live browser crawler should write the same canonical raw role shape here,
 * then the orchestrator handles filters, scoring, materials, and approval routing.
 *
 * This module deliberately never submits applications.
 */
export async function crawlSavedJobs({ root = process.cwd(), policy = null } = {}) {
  const inputDir = policy?.storage?.inputDir || 'input';
  const jsonPath = path.join(root, inputDir, 'saved-jobs.json');
  const csvPath = path.join(root, inputDir, 'saved-jobs.csv');

  if (existsSync(jsonPath)) {
    const roles = JSON.parse(await readFile(jsonPath, 'utf8'));
    return {
      roles: Array.isArray(roles) ? roles : roles.roles || [],
      blocked: [],
      notes: [`Loaded saved jobs from ${path.relative(root, jsonPath)}`]
    };
  }

  if (existsSync(csvPath)) {
    const text = await readFile(csvPath, 'utf8');
    return {
      roles: parseCsv(text),
      blocked: [],
      notes: [`Loaded saved jobs from ${path.relative(root, csvPath)}`]
    };
  }

  return {
    roles: [],
    blocked: [],
    notes: [
      'No local saved-job input found.',
      `Add ${inputDir}/saved-jobs.json or ${inputDir}/saved-jobs.csv, or run the live browser crawler once it is connected.`
    ]
  };
}

function parseCsv(text) {
  const rows = text.split(/\r?\n/).filter((line) => line.trim());
  if (rows.length < 2) return [];
  const headers = splitCsvLine(rows[0]).map((h) => h.trim());
  return rows.slice(1).map((line) => {
    const values = splitCsvLine(line);
    return Object.fromEntries(headers.map((h, i) => [h, values[i] || '']));
  });
}

function splitCsvLine(line) {
  const out = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current.trim());
  return out;
}
