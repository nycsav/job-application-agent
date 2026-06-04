import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRole } from '../lib/codex-role.mjs';
import { evaluateHardFilters, parseSalaryCeiling } from '../lib/codex-filters.mjs';
import { scoreRole } from '../lib/codex-scorer.mjs';
import { routeSubmission } from '../lib/codex-submission-router.mjs';
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

test('routes high score roles through approval-gated paths', () => {
  const role = normalizeRole({ company: 'Acme', title: 'Director AI', url: 'https://boards.greenhouse.io/acme/jobs/1' }, 'linkedin');
  const route = routeSubmission(role, 9, policy);
  assert.equal(route.requiresHumanApproval, true);
  assert.equal(route.route, 'bespoke_direct_ats');
});
