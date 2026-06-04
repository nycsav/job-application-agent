#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { extractDocxText } from '../lib/resume-text.mjs';
import { compareResumeTexts } from '../lib/resume-job-matcher.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const RESUMES = [
  {
    id: 'md_managed_services',
    label: 'MD / Managed Services',
    file: 'materials/resumes/optimized/Sav_Banerjee_Resume_MD_ManagedServices_ATS_2026.docx',
    profileTerms: ['managed services', 'practice', 'operating model', 'transformation', 'delivery', 'executive', 'c-suite']
  },
  {
    id: 'forward_deployed',
    label: 'Forward Deployed AI Architect',
    file: 'materials/resumes/optimized/Sav_Banerjee_Resume_ForwardDeployed_ATS_2026.docx',
    profileTerms: ['forward deployed', 'agentic', 'solution principal', 'architect', 'platform', 'engineering', 'hands-on', 'mcp']
  },
  {
    id: 'ai_advisory',
    label: 'AI Advisory / Transformation',
    file: 'materials/resumes/optimized/Sav_Banerjee_Resume_AI_Transformation_ATS_2026.docx',
    profileTerms: ['advisory', 'transformation', 'strategy', 'operating model', 'stakeholder', 'roadmap', 'change management']
  },
  {
    id: 'product_marketing',
    label: 'Product Marketing / GTM',
    file: 'materials/resumes/optimized/Sav_Banerjee_Resume_PMM_GTM_ATS_2026.docx',
    profileTerms: ['product marketing', 'gtm', 'go-to-market', 'positioning', 'messaging', 'launch', 'sales enablement']
  }
];

export async function matchResumesForJob(job, { root = ROOT } = {}) {
  const resumes = [];
  for (const resume of RESUMES) {
    const absolute = path.join(root, resume.file);
    resumes.push({
      ...resume,
      absolute,
      text: await extractDocxText(absolute)
    });
  }
  return compareResumeTexts(job, resumes);
}

export async function writeResumeMatchReport(job, matches, { root = ROOT } = {}) {
  const slug = safeSlug(`${job.company}-${job.title}`);
  const dir = path.join(root, 'output', 'resume-matches', slug);
  await mkdir(dir, { recursive: true });
  const reportPath = path.join(dir, 'resume-match-report.md');
  const jsonPath = path.join(dir, 'resume-match-report.json');
  await writeFile(jsonPath, JSON.stringify({ job, matches }, null, 2));
  await writeFile(reportPath, renderMarkdown(job, matches));
  return { reportPath, jsonPath };
}

function renderMarkdown(job, matches) {
  const best = matches[0];
  return [
    `# Resume Match Report: ${job.title} @ ${job.company}`,
    '',
    `Recommended resume: **${best.label}**`,
    `Score: **${best.score}/100**`,
    '',
    '## Ranking',
    ...matches.map((match, index) => `${index + 1}. **${match.label}** (${match.score}/100) — ${match.file}`),
    '',
    '## Recommended Rationale',
    best.rationale,
    '',
    '## Matched Keywords',
    best.keywordOverlap.join(', ') || 'None',
    '',
    '## Resume Archetype Signals',
    best.profileHits.join(', ') || 'None',
    '',
    '## Tailoring Gaps',
    best.riskMatches.length ? best.riskMatches.join(', ') : 'None detected',
    '',
    '## All Rationales',
    ...matches.map((match) => `- **${match.label}:** ${match.rationale}`)
  ].join('\n');
}

function safeSlug(value) {
  return String(value || 'job')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--job-json') args.jobJson = argv[++i];
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.jobJson) {
    console.error('Usage: node agents/resume-match.mjs --job-json <path>');
    process.exit(1);
  }
  const job = JSON.parse(await readFile(path.resolve(ROOT, args.jobJson), 'utf8'));
  const matches = await matchResumesForJob(job);
  const report = await writeResumeMatchReport(job, matches);
  console.log(JSON.stringify({ best: matches[0], report }, null, 2));
}
