#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeRole, roleKey } from '../lib/codex-role.mjs';
import { evaluateHardFilters } from '../lib/codex-filters.mjs';
import { scoreRole, bucketForScore } from '../lib/codex-scorer.mjs';
import { prepareMaterials } from '../lib/codex-materials.mjs';
import { routeSubmission } from '../lib/codex-submission-router.mjs';
import { findDuplicate, loadStore, saveRunSummary, saveStore, upsertApplication } from '../lib/codex-store.mjs';
import { crawlSavedJobs } from '../sources/browser-saved-jobs.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

export async function runCodexPipeline({ fixture, roles = [], root = ROOT, stageOnly = true } = {}) {
  const policy = JSON.parse(await readFile(path.join(root, 'config', 'codex-policy.json'), 'utf8'));
  const store = await loadStore(policy, { root });
  const startedAt = new Date().toISOString();
  const crawl = !fixture && roles.length === 0 ? await crawlSavedJobs({ root }) : null;
  const rawRoles = fixture ? JSON.parse(await readFile(path.resolve(root, fixture), 'utf8')) : (roles.length ? roles : crawl.roles);
  const summary = {
    startedAt,
    stageOnly,
    inputCount: rawRoles.length,
    tracked: [],
    skipped: [],
    duplicates: [],
    materials: [],
    routes: [],
    crawler: crawl ? { blocked: crawl.blocked, notes: crawl.notes } : null
  };

  for (const raw of rawRoles) {
    const role = normalizeRole(raw, raw.source || inferSource(raw.url));
    const duplicate = findDuplicate(store, role);
    if (duplicate?.status === 'applied') {
      summary.duplicates.push({ role, reason: 'already applied in local ledger' });
      continue;
    }

    const hard = evaluateHardFilters(role, policy);
    if (!hard.pass) {
      summary.skipped.push({ role, reasons: hard.reasons });
      upsertApplication(store, buildRecord(role, 'skipped', { hardFilterReasons: hard.reasons }));
      continue;
    }

    const score = scoreRole(role);
    const bucket = bucketForScore(score.score, policy.thresholds);
    const base = { score: score.score, scoreBreakdown: score.breakdown, matchedSkills: score.matchedSkills };

    if (bucket === 'skip') {
      summary.skipped.push({ role, reasons: [`score ${score.score} below track threshold`] });
      upsertApplication(store, buildRecord(role, 'skipped', base));
      continue;
    }

    let materials = null;
    let route = null;
    let status = bucket === 'track' ? 'tracked' : 'priority';

    if (bucket === 'materials') {
      materials = await prepareMaterials({ ...role, score: score.score }, policy, { root });
      route = routeSubmission(role, score.score, policy);
      status = 'staged_for_approval';
      summary.materials.push(materials);
      summary.routes.push({ roleId: role.id, company: role.company, title: role.title, ...route });
    }

    const record = buildRecord(role, status, {
      ...base,
      bucket,
      materials,
      route,
      approvalRequired: Boolean(route?.requiresHumanApproval)
    });
    upsertApplication(store, record);
    summary.tracked.push(record);
  }

  store.runs.push({ startedAt, finishedAt: new Date().toISOString(), inputCount: rawRoles.length });
  await saveStore(store, policy, { root });
  summary.ledgerPath = path.join(policy.storage.applicationsPath);
  summary.runSummaryPath = await saveRunSummary(summary, policy, { root });
  return summary;
}

function buildRecord(role, status, extras = {}) {
  return {
    roleKey: roleKey(role),
    role,
    status,
    updatedAt: new Date().toISOString(),
    history: [{ at: new Date().toISOString(), status }],
    ...extras
  };
}

function inferSource(url = '') {
  const u = String(url).toLowerCase();
  if (u.includes('linkedin')) return 'linkedin';
  if (u.includes('indeed')) return 'indeed';
  if (u.includes('theladders') || u.includes('ladders')) return 'ladders';
  if (u.includes('dice')) return 'dice';
  return 'manual';
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith('--') ? next : true;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runCodexPipeline({
    fixture: args.fixture,
    stageOnly: args['stage-only'] !== false
  });
  console.log(JSON.stringify({
    inputCount: summary.inputCount,
    tracked: summary.tracked.length,
    skipped: summary.skipped.length,
    duplicates: summary.duplicates.length,
    materials: summary.materials.length,
    routes: summary.routes.length,
    ledgerPath: summary.ledgerPath,
    runSummaryPath: summary.runSummaryPath
  }, null, 2));
}
