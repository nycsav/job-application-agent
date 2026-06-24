#!/usr/bin/env node
/**
 * Resume Picker — resolve a role to one of Sav's pre-approved resume PDFs.
 *
 * Uses config/resume_map.json (the single source of truth for which PDF goes
 * with which role type). Does NOT regenerate resumes — picks the right existing
 * PDF and returns its absolute path so the Submitter can upload it to the ATS.
 *
 * The actual PDFs live in materials/resumes/ which is gitignored (PII). This
 * module reports whether the file is present on disk so the Submitter can warn
 * instead of silently uploading nothing.
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let _map = null;
function loadMap() {
  if (!_map) _map = JSON.parse(readFileSync(join(ROOT, 'config', 'resume_map.json'), 'utf-8'));
  return _map;
}

// Map an explicit "Resume Version" hint (as staged in Notion) to a cluster key.
// Order matters (first match wins). Handles BOTH the new archetype names and the
// legacy strings still on existing Notion rows (v3, PMM_v2, ForwardDeployed, MD_*).
function clusterFromVersion(v = '') {
  const s = v.toLowerCase();
  if (/forward.?deployed|fde|architect|applied|agentic|builder|\bclaude\b|solutions? engineer|\bengineer\b/.test(s)) return 'forward_deployed';
  if (/managed|fractional|contract|consult|managing director|\bmd\b|delivery|interim|practice/.test(s)) return 'managed_services';
  if (/pmm|product marketing|\bgtm\b|go.?to.?market|growth|\bsales\b|partnership|alliance|channel|demand|enterprise growth|commercial/.test(s)) return 'enterprise_growth';
  if (/advisory|transformation|strategy|enablement|change|master|\bv3\b/.test(s)) return 'ai_transformation';
  return null;
}

/**
 * Pick the best resume for a role.
 * @param {object} role - { title, resumeVersion }
 * @returns {{cluster,file,absPath,exists,angle}}
 */
export function pickResume({ title = '', resumeVersion = '' } = {}) {
  const map = loadMap();

  // 1. Honor the explicit version we staged in Notion.
  let cluster = clusterFromVersion(resumeVersion);

  // 2. Otherwise match the title against each cluster's best_for list.
  if (!cluster) {
    const hay = title.toLowerCase();
    for (const [key, def] of Object.entries(map.resumes)) {
      if ((def.best_for || []).some((b) => hay.includes(b.toLowerCase()))) { cluster = key; break; }
    }
  }

  // 3. Fall back to the documented default.
  if (!cluster || !map.resumes[cluster]) cluster = map.matching_rules?.default || 'ai_transformation';

  const def = map.resumes[cluster];
  const absPath = join(ROOT, def.file);
  return { cluster, file: def.file, absPath, exists: existsSync(absPath), angle: def.angle };
}

// ─── CLI: show the mapping + which PDFs are present on disk ──────────
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const map = loadMap();
  console.log('\nResume map — file presence check:\n');
  for (const [key, def] of Object.entries(map.resumes)) {
    const ok = existsSync(join(ROOT, def.file));
    console.log(`  ${ok ? '✅' : '❌ MISSING'}  ${key.padEnd(18)} → ${def.file}`);
  }
  console.log('\n❌ = PDF not on disk. Put it in materials/resumes/ before submitting.\n');
}
