import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { classifyRoleArchetypes } from './codex-archetypes.mjs';

export async function chooseResumeCluster(role, { root = process.cwd() } = {}) {
  const [candidate, resumeMap] = await Promise.all([
    readJson(path.join(root, 'config', 'candidate.json')).catch(() => ({})),
    readJson(path.join(root, 'config', 'resume_map.json'))
  ]);

  const archetypeRoute = routeFromArchetype(role, resumeMap);
  if (archetypeRoute) return withDocxFallback(archetypeRoute, root);

  const routed = routeFromCandidateRules(role, candidate);
  if (routed) return withDocxFallback(routed, root);

  const title = lower(role.title);
  const company = lower(role.company);
  const jd = lower(`${role.description || ''} ${role.requirements || ''}`);

  for (const [cluster, spec] of Object.entries(resumeMap.resumes || {})) {
    if ((spec.best_for || []).some((item) => title.includes(lower(item)) || lower(item).includes(title))) {
      return withDocxFallback({ cluster, ...spec }, root);
    }
    if ((spec.example_companies || []).some((item) => company.includes(lower(item).split(' ')[0]))) {
      return withDocxFallback({ cluster, ...spec }, root);
    }
  }

  if (/consult|advisory|transformation|managed services|fractional|contract/.test(jd)) {
    return withDocxFallback({ cluster: 'ai_consulting', ...resumeMap.resumes.ai_consulting }, root);
  }
  if (/partnership|alliance|channel|business development|co-sell/.test(jd)) {
    return withDocxFallback({ cluster: 'ai_partnerships', ...resumeMap.resumes.ai_partnerships }, root);
  }
  if (/product marketing|gtm|go-to-market|positioning|launch/.test(jd)) {
    return withDocxFallback({ cluster: 'product_marketing', ...resumeMap.resumes.product_marketing }, root);
  }

  const fallback = resumeMap.matching_rules?.default || 'ai_builder';
  return withDocxFallback({ cluster: fallback, ...resumeMap.resumes[fallback] }, root);
}

function routeFromArchetype(role, resumeMap) {
  const classification = classifyRoleArchetypes(role);
  const best = classification.best;
  if (!best || best.score < 4) return null;

  const cluster = best.resumeCluster;
  const spec = resumeMap.resumes?.[cluster];
  if (!cluster || !spec) return null;

  return {
    cluster,
    ...spec,
    archetype: best.label,
    archetypeId: best.id,
    strategicFit: best.score,
    angle: `${spec.angle} Archetype route: ${best.label}.`
  };
}

function routeFromCandidateRules(role, candidate) {
  const routing = candidate.resume_routing || {};
  const title = lower(role.title);
  const company = lower(role.company);
  const resume = candidate.resume || {};

  if (matches(company, routing.md_companies) || matches(title, routing.md_keywords)) {
    return { cluster: 'ai_consulting', file: resume.alternates?.md_managed_services, angle: 'Managing Director / AI consulting route' };
  }
  if (matches(company, routing.pmm_companies) || matches(title, routing.pmm_keywords)) {
    return { cluster: 'product_marketing', file: resume.alternates?.perplexity_pmm, angle: 'Product marketing / GTM route' };
  }
  if (matches(company, routing.forward_deployed_companies) || matches(title, routing.forward_deployed_keywords)) {
    return { cluster: 'ai_builder', file: resume.alternates?.forward_deployed, angle: 'Forward-deployed AI builder route' };
  }
  if (resume.default_path) {
    return { cluster: 'ai_advisory', file: resume.default_path, angle: 'Default AI advisory route' };
  }
  return null;
}

function withDocxFallback(match, root) {
  const file = match.file || '';
  const absolute = path.resolve(root, file);
  const docx = absolute.replace(/\.pdf$/i, '.docx');
  return {
    ...match,
    file,
    absolutePath: absolute,
    preferredDocxPath: docx
  };
}

function matches(value, list = []) {
  return list.some((item) => value.includes(lower(item)));
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function lower(value = '') {
  return String(value || '').toLowerCase();
}
