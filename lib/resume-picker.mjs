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
function clusterFromVersion(v = '') {
  // Normalize separators: Notion hints arrive as "ForwardDeployed_v4",
  // "MD_ManagedServices", "PMM_v2" — underscores/camelCase, not spaces.
  const s = v.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').toLowerCase();
  if (/managed|fractional|contract|consulting|consultant/.test(s)) return 'ai_consulting';
  if (/partnership|alliance|channel/.test(s)) return 'ai_partnerships';
  if (/pmm|product marketing|gtm/.test(s)) return 'product_marketing';
  if (/advisory|transformation|strategy|enablement|change|v3/.test(s)) return 'ai_advisory';
  if (/forward deployed|fde|architect|claude|builder|applied|agentic/.test(s)) return 'ai_builder';
  return null;
}

/**
 * Title signals per cluster. Scored, not all-or-nothing: a role title rarely
 * contains a whole best_for phrase verbatim ("Director, GTM Sales - AI
 * Operations" contains none of them), so phrase matching alone sent almost
 * every GTM role to the default. These regexes catch the actual words.
 */
const SIGNALS = {
  ai_partnerships: [
    [/\b(partnership|partnerships|partner)\b/, 3],
    [/\b(alliance|alliances)\b/, 4],
    [/\b(channel|co-?sell|ecosystem)\b/, 3],
    [/\bbusiness development\b/, 3],
  ],
  product_marketing: [
    [/\b(gtm|go-?to-?market)\b/, 3],
    [/\b(product marketing|pmm)\b/, 4],
    [/\b(demand gen|demand generation|growth|positioning)\b/, 3],
    [/\b(marketing|enablement|revenue operations|revops)\b/, 2],
  ],
  ai_consulting: [
    [/\b(fractional|interim|1099)\b/, 4],
    [/\b(consultant|consulting)\b/, 3],
    [/\b(contract|managed services|advisor)\b/, 2],
    [/\bdelivery (lead|leader)\b/, 2],
  ],
  ai_advisory: [
    [/\btransformation\b/, 3],
    [/\b(strategy|strategic)\b/, 2],
    [/\b(advisory|change management|center of excellence|coe)\b/, 3],
  ],
  ai_builder: [
    [/\b(architect|architecture)\b/, 4],
    [/\b(engineer|engineering)\b/, 3],
    [/\b(applied ai|forward deployed|fde|agentic)\b/, 4],
    [/\b(cto|chief technology officer|head of ai|chief ai officer)\b/, 4],
    [/\b(deployment|platform|technical|systems)\b/, 2],
  ],
};

// Tie-break order when two clusters score equally — most specific angle first.
const PRECEDENCE = ['ai_partnerships', 'ai_consulting', 'ai_builder', 'product_marketing', 'ai_advisory'];

function scoreTitle(title = '') {
  const hay = ` ${title.toLowerCase()} `;
  const scores = {};
  for (const [key, sigs] of Object.entries(SIGNALS)) {
    let n = 0;
    for (const [re, w] of sigs) if (re.test(hay)) n += w;
    if (n) scores[key] = n;
  }
  return scores;
}

/**
 * Pick the best resume for a role.
 * @param {object} role - { title, resumeVersion, fractional }
 *   resumeVersion - explicit hint staged in Notion; always wins.
 *   fractional    - true for contract / part-time engagements (Fractional Jobs,
 *                   hourly, "N hrs / week"). Routes to the MD/Managed-Services
 *                   resume, which resume_map.json defines as the contract track.
 * @returns {{cluster,file,absPath,exists,angle,why}}
 */
export function pickResume({ title = '', resumeVersion = '', fractional = false } = {}) {
  const map = loadMap();
  let cluster = null;
  let why = '';

  // 1. Honor the explicit version we staged in Notion.
  cluster = clusterFromVersion(resumeVersion);
  if (cluster) why = `explicit Resume Version hint: "${resumeVersion}"`;

  // 2. A fractional/contract engagement is the managed-services track by
  //    definition — an engagement-type modifier outranks the functional title.
  //    "Fractional Head of AI" is a contract engagement, not a builder role.
  const titleIsFractional = /\b(fractional|interim|1099|part-?time)\b/i.test(title);
  if (!cluster && (fractional || titleIsFractional)) {
    cluster = 'ai_consulting';
    why = titleIsFractional
      ? 'title declares a fractional/interim engagement'
      : 'fractional/contract engagement';
  }

  // 3. Score keyword signals AND exact best_for phrases together, so they
  //    compete. Short-circuiting on best_for let ai_builder's "Head of AI"
  //    beat ai_consulting's "fractional" on "Fractional Head of AI".
  if (!cluster) {
    const scores = scoreTitle(title);
    const hay = title.toLowerCase();
    const phrases = {};
    for (const [key, def] of Object.entries(map.resumes)) {
      const hit = (def.best_for || []).find((b) => hay.includes(b.toLowerCase()));
      if (hit) { scores[key] = (scores[key] || 0) + 5; phrases[key] = hit; }
    }
    const best = Object.entries(scores).sort(
      (a, b) => b[1] - a[1] || PRECEDENCE.indexOf(a[0]) - PRECEDENCE.indexOf(b[0])
    )[0];
    if (best) {
      cluster = best[0];
      why = phrases[cluster]
        ? `best_for "${phrases[cluster]}" + signals ${JSON.stringify(scores)}`
        : `signals ${JSON.stringify(scores)}`;
    }
  }

  // 5. Fall back to the documented default.
  if (!cluster || !map.resumes[cluster]) {
    cluster = map.matching_rules?.default || 'ai_builder';
    why = why || 'no signal — documented default';
  }

  const def = map.resumes[cluster];
  const absPath = join(ROOT, def.file);
  return { cluster, file: def.file, absPath, exists: existsSync(absPath), angle: def.angle, why };
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

// ─── Self-tests: node lib/resume-picker.mjs --test ───────────────────
// Guards the 2026-10-05 fix: phrase-only matching sent ~25/27 GTM titles to the
// ai_builder default, collapsing four resume variants into one.
export function selfTest() {
  const cases = [
    // [title, fractional, expected cluster]
    ['Sr. Director, GTM Strategy & AI Automation', false, 'product_marketing'],
    ['Director, GTM Sales - AI Operations', false, 'product_marketing'],
    ['VP, GTM Enablement', false, 'product_marketing'],
    ['AI Architect - GTM', false, 'ai_builder'],
    ['Principal GTM Systems Architect', false, 'ai_builder'],
    ['Enterprise AI Strategic Alliances Consultant', false, 'ai_partnerships'],
    ['Agency Partnerships Lead', false, 'ai_partnerships'],
    ['Applied AI Architect', true, 'ai_consulting'],   // fractional wins
    ['Applied AI Architect', false, 'ai_builder'],     // same title, full-time
    ['Fractional Head of AI', false, 'ai_consulting'],
    ['Director, AI Transformation & Customer Success', false, 'ai_advisory'],
  ];
  let pass = 0;
  for (const [title, fractional, want] of cases) {
    const got = pickResume({ title, fractional }).cluster;
    const ok = got === want;
    if (ok) pass++;
    else console.log(`  ❌ "${title}" (fractional=${fractional}) → ${got}, expected ${want}`);
  }
  // An explicit Notion hint must always override the title.
  const forced = pickResume({ title: 'VP, GTM Enablement', resumeVersion: 'ForwardDeployed_v4' }).cluster;
  if (forced === 'ai_builder') pass++;
  else console.log(`  ❌ explicit resumeVersion override → ${forced}, expected ai_builder`);

  const total = cases.length + 1;
  console.log(`\n  ${pass}/${total} resume-picker tests passed\n`);
  return pass === total;
}

if (process.argv.includes('--test')) process.exit(selfTest() ? 0 : 1);
