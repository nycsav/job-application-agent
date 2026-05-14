#!/usr/bin/env node
import { generateAllPending } from './agents/materials.mjs';
import { createSubmissionPlan, PLATFORM_STRATEGIES } from './agents/submitter.mjs';
import { loadRoles } from './lib/template-engine.mjs';
import { TARGET_COMPANIES, scoreRole } from './agents/scanner.mjs';

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

async function runFull() {
  console.log('\n🚀 Starting full pipeline...\n');
  console.log('=== PHASE 1: SCANNING ===');
  console.log(`Target companies: ${TARGET_COMPANIES.map(c => c.name).join(', ')}`);
  console.log('(Run via Claude Code Routine for live scanning)\n');
  console.log('=== PHASE 2: GENERATING MATERIALS ===');
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

const mode = process.argv[2] || '--status';
switch (mode) {
  case '--scan':    console.log('Scanner requires Claude Code Routine with web_fetch.'); break;
  case '--generate': generateAllPending().then(r => console.log(`Generated ${r.length} material sets.`)).catch(console.error); break;
  case '--submit':  console.log('Submitter requires Claude Code with Playwright MCP.'); break;
  case '--full':    runFull().catch(console.error); break;
  case '--status':  showStatus().catch(console.error); break;
  default: console.log('Usage: node orchestrator.mjs [--scan|--generate|--submit|--full|--status]');
}
