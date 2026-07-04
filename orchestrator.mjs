#!/usr/bin/env node
import { mkdir, appendFile, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateAllPending } from './agents/materials.mjs';
import { createSubmissionPlan, PLATFORM_STRATEGIES } from './agents/submitter.mjs';
import { loadRoles } from './lib/template-engine.mjs';
import { TARGET_COMPANIES, scoreRole } from './agents/scanner.mjs';
import { scanSubstack } from './agents/substack-scanner.mjs';
import { runManager } from './agents/manager.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

// Phase 1 = shadow mode: write Substack discoveries to a log, NOT the Google Sheet.
// Flip to false after 3 clean runs to enable sheet integration (Phase 2).
const SUBSTACK_SHADOW_MODE = true;
const SUBSTACK_LOG_PATH = join(ROOT, 'reports', 'substack-discoveries.log');

async function showStatus() {
  const { roles } = await loadRoles();
  const counts = {
    total: roles.length,
    materials_ready: roles.filter(r => r.status === 'materials_ready').length,
    applied: roles.filter(r => r.status === 'applied').length,
    pending: roles.filter(r => r.status === 'pending' || !r.status).length,
    paused: roles.filter(r => r.status === 'paused').length
  };
  console.log(`\n=== JOB ENGINE - PIPELINE STATUS ===`);
  console.log(`Total roles tracked:    ${String(counts.total).padStart(3)}`);
  console.log(`Materials ready:        ${String(counts.materials_ready).padStart(3)}`);
  console.log(`Applied:                ${String(counts.applied).padStart(3)}`);
  console.log(`Pending materials:      ${String(counts.pending).padStart(3)}`);
  console.log(`Paused:                 ${String(counts.paused).padStart(3)}`);

  const byCompany = {};
  for (const role of roles) {
    if (!byCompany[role.company]) byCompany[role.company] = [];
    byCompany[role.company].push(role);
  }
  for (const [company, companyRoles] of Object.entries(byCompany)) {
    console.log(`\n  ${company}:`);
    for (const r of companyRoles) {
      const statusIcon = { materials_ready: '📄', applied: '✅', pending: '⏳', paused: '⏸️' }[r.status] || '❓';
      console.log(`    ${statusIcon} [${r.score || '?'}] ${r.title} — ${r.status || 'no status'}`);
    }
  }
}

/**
 * Substack source — Phase 1 shadow run.
 * Fetches RSS feeds, scores listings, writes everything to a log file.
 * No sheet writes, no materials triggers — pure observation mode.
 * Promote to Phase 2 by setting SUBSTACK_SHADOW_MODE = false after 3 clean runs.
 */
async function runSubstackScan() {
  console.log('\n=== SOURCE 3: SUBSTACK NEWSLETTERS ===');
  try {
    const { summary, listings } = await scanSubstack();
    console.log(`Feeds scanned: ${summary.feeds_scanned} | posts with jobs: ${summary.posts_with_jobs} | listings extracted: ${summary.total_listings} | kept after scoring: ${summary.kept_after_scoring}`);
    if (summary.errors.length) {
      console.log('Feed errors:', summary.errors.map(e => `${e.feed} (${e.error})`).join('; '));
    }
    if (listings.length) {
      console.log(`Top discoveries:`);
      for (const r of listings.slice(0, 5)) {
        console.log(`  [${r.score}] ${r.company} — ${r.title} (${r.location || 'loc?'}) ← ${r.source_publication}`);
      }
    }
    if (SUBSTACK_SHADOW_MODE) {
      await mkdir(dirname(SUBSTACK_LOG_PATH), { recursive: true });
      const entry = {
        run_at: new Date().toISOString(),
        mode: 'shadow',
        summary,
        listings,
      };
      await appendFile(SUBSTACK_LOG_PATH, JSON.stringify(entry) + '\n');
      console.log(`📝 Shadow-logged ${listings.length} listings to reports/substack-discoveries.log`);
    } else {
      console.log('⚠️  Phase 2 active — would push to Notion Career Command Center (not yet implemented).');
    }
    return listings;
  } catch (err) {
    console.error('Substack scan failed:', err.message);
    return [];
  }
}

async function runFull() {
  console.log('\n🚀 Starting full pipeline...\n');
  console.log('=== PHASE 1: SCANNING ===');
  console.log(`Target companies: ${TARGET_COMPANIES.map(c => c.name).join(', ')}`);
  console.log('(Sources 1 & 2 — Gmail + career pages — run via Claude Code Routine for live scanning)');
  await runSubstackScan();
  console.log('\n=== PHASE 2: GENERATING MATERIALS ===');
  const materials = await generateAllPending();
  if (materials.length > 0) {
    console.log(`Generated materials for ${materials.length} roles:`);
    materials.forEach(m => console.log(`  ✓ ${m.roleId}`));
  } else {
    console.log('All roles already have materials.\n');
  }
  console.log('\n=== PHASE 3: SUBMISSION PLANS ===');
  const { roles } = await loadRoles();
  const ready = roles.filter(r => r.status === 'materials_ready');
  if (ready.length > 0) {
    console.log(`${ready.length} roles ready for submission:\n`);
    for (const role of ready) {
      try {
        const plan = await createSubmissionPlan(role.id);
        console.log(`  📋 ${plan.company} — ${plan.title}`);
        console.log(`     Platform: ${plan.platform}`);
        console.log(`     URL: ${plan.apply_url}`);
        console.log(`     Steps: ${plan.steps.length}\n`);
      } catch (err) {
        console.log(`  ⚠️ ${role.company} — ${role.title}: ${err.message}`);
      }
    }
    console.log('⚠️  Actual submission requires Claude Code with Playwright MCP.');
  } else {
    console.log('No roles ready for submission.\n');
  }
}

/**
 * Manager mode — the parallel orchestrator (docs/parallel-agent-architecture.html).
 * Live: Claude Code calls runManager(ctx) with MCP-backed source specialists +
 * the current Notion rows, then performs the keyed notion-create-pages writes.
 * CLI: replays reports/parallel-scan-fixture.json so the full path is verifiable.
 */
async function runManagerMode() {
  console.log('\n=== MANAGER — parallel discovery → score → keyed dedup → tailor → stage → GATE ===');
  let fixture = [];
  try { fixture = JSON.parse(await readFile(join(ROOT, 'fixtures', 'parallel-scan-fixture.json'), 'utf8')); }
  catch { console.log('No fixture present. In live use, Claude Code injects MCP source specialists.'); return; }
  const ctx = { specialists: { fixture: { label: 'fixture replay', run: async () => fixture } } };
  const out = await runManager(ctx, {});
  const l = out.runLog;
  console.log(`scanned ${l.scanned} · staged ${l.staged} · click-ready ${l.clickReady} · needs-you ${l.needsYou} · dedup-skipped ${l.duplicatesSkipped}`);
  console.log(`🔒 GATE owned — nothing submits without Sav. For the full report run: node agents/manager.mjs`);
}

const mode = process.argv[2] || '--status';
switch (mode) {
  case '--scan':    console.log('Scanner requires Claude Code Routine with web_fetch.'); break;
  case '--scan-substack': runSubstackScan().catch(console.error); break;
  case '--manager': runManagerMode().catch(console.error); break;
  case '--generate': generateAllPending().then(r => console.log(`Generated ${r.length} material sets.`)).catch(console.error); break;
  case '--submit':  console.log('Submitter requires Claude Code with Playwright MCP.'); break;
  case '--full':    runFull().catch(console.error); break;
  case '--status':  showStatus().catch(console.error); break;
  default: console.log('Usage: node orchestrator.mjs [--scan|--scan-substack|--manager|--generate|--submit|--full|--status]');
}
