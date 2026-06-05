import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRole } from '../lib/codex-role.mjs';
import { evaluateHardFilters, parseSalaryCeiling } from '../lib/codex-filters.mjs';
import { scoreRole } from '../lib/codex-scorer.mjs';
import { classifyRoleArchetypes } from '../lib/codex-archetypes.mjs';
import { evaluateRoleAlignment } from '../lib/codex-alignment.mjs';
import { chooseResumeCluster } from '../lib/codex-resume-router.mjs';
import { buildMarketSearchQueries, classifyMarketOpportunity } from '../lib/enso-market-strategy.mjs';
import { routeSubmission } from '../lib/codex-submission-router.mjs';
import { crawlSavedJobs } from '../sources/browser-saved-jobs.mjs';
import { buildJobSearchQueries } from '../lib/gmail-accounts.mjs';
import { ensureGmailLabel, gmailLabelSearchTerm, moveMessageToGmailLabel } from '../lib/gmail-labels.mjs';
import { compareResumeTexts } from '../lib/resume-job-matcher.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import policy from '../config/codex-policy.json' with { type: 'json' };

test('normalizes source roles into canonical shape', () => {
  const role = normalizeRole({ companyName: 'Acme', title: 'Director AI', detailsPageUrl: 'https://boards.greenhouse.io/acme/jobs/1' }, 'linkedin');
  assert.equal(role.company, 'Acme');
  assert.equal(role.platform, 'greenhouse');
  assert.equal(role.source, 'linkedin');
});

test('parses salary ceiling from common ranges', () => {
  assert.equal(parseSalaryCeiling('USD 164,350.00 - 260,000.00 per year'), 260000);
  assert.equal(parseSalaryCeiling('$279K - $346K'), 346000);
  assert.equal(parseSalaryCeiling('$85/hr - $100/hr'), 208000);
});

test('hard filters block excluded companies and low compensation', () => {
  const excluded = normalizeRole({ company: 'Perplexity AI', title: 'VP AI', location: 'Remote', salary: '$250K' });
  assert.equal(evaluateHardFilters(excluded, policy).pass, false);

  const low = normalizeRole({ company: 'Acme', title: 'Director AI', location: 'New York', salary: '$120K - $150K' });
  assert.equal(evaluateHardFilters(low, policy).pass, false);
});

test('scores strong AI strategy roles at materials threshold', () => {
  const role = normalizeRole({
    company: 'ButterflyMX',
    title: 'Director, AI Strategy & Transformation',
    location: 'New York, NY',
    salary: 'USD 200,000 - 240,000',
    description: 'Lead AI strategy and transformation. Agentic AI architecture, C-suite advisory, enterprise AI strategy, pilot to production, consulting.'
  });
  assert.equal(scoreRole(role).score >= policy.thresholds.materials, true);
});

test('classifies SoftServe-style roles as forward-deployed solution principal', () => {
  const role = normalizeRole({
    company: 'SoftServe',
    title: 'Agentic Solution Principal',
    location: 'Remote',
    description: 'Set technical direction for agentic workflows, MCP tools, client stakeholders, solution architecture, production systems, and enterprise deployment.'
  });
  const classification = classifyRoleArchetypes(role);
  assert.equal(classification.best.id, 'forward_deployed_ai_strategist');
  assert.equal(classification.best.resumeCluster, 'ai_builder');
  assert.equal(classification.strategicFit >= 8, true);
});

test('scores and routes approved archetypes to matching resume clusters', async () => {
  const vpTransformation = normalizeRole({
    company: 'Acme',
    title: 'VP AI Transformation',
    location: 'New York',
    salary: '$240K',
    description: 'Own enterprise AI roadmap, operating model, C-suite governance, executive stakeholders, and value realization.'
  });
  const managedServices = normalizeRole({
    company: 'Acme',
    title: 'AI CoE Managed Services Implementation Partner',
    location: 'Remote',
    salary: '$220K',
    description: 'Lead center of excellence, managed services, deployment playbooks, governance, enablement, and ongoing operations.'
  });

  assert.equal(scoreRole(vpTransformation).archetype.id, 'vp_director_ai_transformation');
  assert.equal(scoreRole(managedServices).archetype.id, 'ai_coe_managed_services');
  assert.equal((await chooseResumeCluster(vpTransformation)).cluster, 'ai_advisory');
  assert.equal((await chooseResumeCluster(managedServices)).cluster, 'ai_consulting');
});

test('aligns role scoring across candidate corpus market category and JD', () => {
  const role = normalizeRole({
    company: 'Smartsheet',
    title: 'Senior Forward Deployed AI Strategist',
    location: 'Remote',
    salary: '$230K',
    description: 'Own technical discovery through production deployment, design multi-agent solutions, MCP deployment kits, enterprise systems, cloud infrastructure, agentic workflow transformation, evaluation, observability, C-suite stakeholder alignment, and pilot-to-production outcomes.'
  });
  const alignment = evaluateRoleAlignment(role);
  assert.equal(alignment.archetype.id, 'forward_deployed_ai_strategist');
  assert.equal(alignment.score >= 8, true);
  assert.equal(alignment.candidateCorpusFit >= 7, true);
  assert.equal(alignment.marketCategoryFit >= 7, true);
  assert.equal(alignment.flags.includes('weak_candidate_evidence_overlap'), false);
});

test('penalizes senior roles that do not align to AI transformation market or resume evidence', () => {
  const role = normalizeRole({
    company: 'Legacy Agency',
    title: 'VP Brand Strategy',
    location: 'New York',
    salary: '$240K',
    description: 'Lead brand strategy, campaign planning, advertising strategy, creative briefs, media planning, and agency account growth.'
  });
  const alignment = evaluateRoleAlignment(role);
  assert.equal(alignment.score < 5, true);
  assert.equal(alignment.flags.includes('legacy_advertising_without_ai_pivot'), true);
  assert.equal(scoreRole(role).score < policy.thresholds.materials, true);
});

test('classifies Enso Labs consulting prospects with contract economics', () => {
  const opportunity = {
    company: 'PressW',
    title: 'Claude Managed Services Implementation Partner',
    description: 'Deploy, manage, and optimize Claude across enterprise organizations with custom agent development, MCP integration, managed services, governance, observability, and AI transformation support for media and marketing teams.'
  };
  const result = classifyMarketOpportunity(opportunity);
  assert.equal(result.type, 'contract');
  assert.equal(result.searchTrack, 'contract_project');
  assert.equal(result.economics.hourlyFloor, 175);
  assert.equal(['send_paid_diagnostic_pitch', 'track_and_research'].includes(result.recommendedAction), true);
});

test('flags low-comp W2 opportunities below Enso strategy floor', () => {
  const opportunity = {
    company: 'LowComp AI',
    title: 'Forward Deployed AI Strategist',
    salary: '$120K - $150K',
    description: 'Client-facing production AI deployment, agentic workflows, MCP, enterprise customers, and pilot-to-production outcomes.'
  };
  const result = classifyMarketOpportunity(opportunity);
  assert.equal(result.type, 'w2');
  assert.equal(result.economics.pass, false);
  assert.equal(result.recommendedAction, 'skip_or_negotiate_comp');
});

test('builds market search queries for both W2 and Enso prospecting', () => {
  const queries = buildMarketSearchQueries();
  assert.equal(queries.w2.some((query) => query.includes('Forward Deployed')), true);
  assert.equal(queries.contract.some((query) => query.includes('Claude managed services')), true);
  assert.equal(queries.clientProspecting.some((query) => query.includes('media AI transformation')), true);
});

test('routes high score roles through approval-gated paths', () => {
  const role = normalizeRole({ company: 'Acme', title: 'Director AI', url: 'https://boards.greenhouse.io/acme/jobs/1' }, 'linkedin');
  const route = routeSubmission(role, 9, policy);
  assert.equal(route.requiresHumanApproval, true);
  assert.equal(route.route, 'bespoke_direct_ats');
});

test('loads saved jobs from local json input', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-jobs-'));
  await mkdir(path.join(root, 'input'));
  await writeFile(path.join(root, 'input', 'saved-jobs.json'), JSON.stringify([
    { company: 'Acme', title: 'Director AI', location: 'Remote' }
  ]));
  const result = await crawlSavedJobs({ root, policy });
  assert.equal(result.roles.length, 1);
  assert.equal(result.roles[0].company, 'Acme');
});

test('builds multi-account Gmail job queries with a time window', () => {
  const queries = buildJobSearchQueries({ hours: 12 });
  assert.equal(queries.every((query) => query.includes('newer_than:12h')), true);
  assert.equal(queries.some((query) => query.includes('linkedin.com')), true);
  assert.equal(queries.every((query) => query.includes('-label:"Codex Job Applications"')), true);
});

test('formats Gmail label exclusion terms for search', () => {
  assert.equal(gmailLabelSearchTerm('Codex Job Applications'), '-label:"Codex Job Applications"');
});

test('creates and applies Gmail processed label while archiving from inbox', async () => {
  const calls = [];
  const gmail = {
    users: {
      labels: {
        list: async () => ({ data: { labels: [] } }),
        create: async (request) => {
          calls.push(['labels.create', request]);
          return { data: { id: 'Label_123' } };
        }
      },
      messages: {
        modify: async (request) => {
          calls.push(['messages.modify', request]);
          return { data: {} };
        }
      }
    }
  };

  assert.equal(await ensureGmailLabel(gmail, 'Codex Job Applications'), 'Label_123');
  await moveMessageToGmailLabel(gmail, 'msg-1', 'Codex Job Applications');
  assert.equal(calls[0][0], 'labels.create');
  assert.deepEqual(calls[2][1].requestBody, {
    addLabelIds: ['Label_123'],
    removeLabelIds: ['INBOX']
  });
});

test('matches resume text against job dimensions', () => {
  const job = {
    title: 'Agentic Solution Principal',
    description: 'Lead agentic workflows, MCP tools, client stakeholders, technical direction, and production deployment.'
  };
  const matches = compareResumeTexts(job, [
    { id: 'a', label: 'Agentic', file: 'a.docx', text: 'MCP agentic workflows client stakeholders production deployment technical direction' },
    { id: 'b', label: 'Marketing', file: 'b.docx', text: 'product positioning go-to-market launch messaging' }
  ]);
  assert.equal(matches[0].id, 'a');
  assert.equal(matches[0].score > matches[1].score, true);
});
