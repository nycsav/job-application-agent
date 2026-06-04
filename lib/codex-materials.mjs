import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chooseResumeCluster } from './codex-resume-router.mjs';

export async function prepareMaterials(role, policy, { root = process.cwd() } = {}) {
  const materialsRoot = path.join(root, policy.storage.materialsDir, safeSlug(`${role.company}-${role.title}`));
  await mkdir(materialsRoot, { recursive: true });

  const resume = await chooseResumeCluster(role, { root });
  const sourceResume = existsSync(resume.preferredDocxPath) ? resume.preferredDocxPath : resume.absolutePath;
  const resumeExt = path.extname(sourceResume) || '.docx';
  const resumeOut = path.join(materialsRoot, `${safeSlug(role.company)}-${safeSlug(role.title)}-resume-base${resumeExt}`);
  if (existsSync(sourceResume)) {
    await copyFile(sourceResume, resumeOut);
  }

  const tailoringBrief = buildResumeTailoringBrief(role, resume);
  const coverLetter = buildCoverLetter(role);
  const manifest = {
    roleId: role.id,
    company: role.company,
    title: role.title,
    generatedAt: new Date().toISOString(),
    resumeCluster: resume.cluster,
    resumeAngle: resume.angle,
    sourceResume,
    localResume: existsSync(sourceResume) ? resumeOut : null,
    coverLetterPath: path.join(materialsRoot, 'cover-letter.md'),
    tailoringBriefPath: path.join(materialsRoot, 'resume-tailoring-brief.md')
  };

  await writeFile(manifest.tailoringBriefPath, tailoringBrief);
  await writeFile(manifest.coverLetterPath, coverLetter);
  await writeFile(path.join(materialsRoot, 'materials-manifest.json'), JSON.stringify(manifest, null, 2));

  return manifest;
}

function buildResumeTailoringBrief(role, resume) {
  return [
    `# Resume Tailoring Brief: ${role.title} @ ${role.company}`,
    '',
    `Base cluster: ${resume.cluster}`,
    `Base angle: ${resume.angle || 'n/a'}`,
    '',
    '## Role Signals',
    `- Location: ${role.location || 'Not listed'}`,
    `- Salary: ${role.salary || 'Not listed'}`,
    `- Source: ${role.source || 'manual'}`,
    `- URL: ${role.url || 'n/a'}`,
    '',
    '## Tailoring Instructions',
    '- Preserve verified metrics exactly as written in candidate.json.',
    '- Do not invent client names, revenue numbers, dates, certifications, or outcomes.',
    '- Prefer the strongest 3-5 bullets that map to the live JD.',
    '- Align the summary and skills line to the role title and top JD keywords.',
    '- Keep ATS format single-column and plain.',
    '',
    '## JD Excerpt',
    role.description || 'No JD text captured yet.'
  ].join('\n');
}

function buildCoverLetter(role) {
  const portfolioUrl = 'ensolabs.ai/work/enterprise-ai';
  return [
    `Sav Banerjee`,
    `New York, NY`,
    '',
    `Dear ${role.company} team,`,
    '',
    `I am interested in the ${role.title} role because it sits directly at the intersection of enterprise AI strategy, production agentic systems, and executive-level transformation work.`,
    '',
    `At Enso Labs, I have built and led production AI deployments across finance, healthcare, and B2B technology, including systems that moved from pilot to production at a verified 75% rate. The work is represented in live portfolio form at ${portfolioUrl}.`,
    '',
    `For this role, I would bring a practical blend of C-suite advisory experience, hands-on AI architecture judgment, and the operating discipline to turn promising AI use cases into governed production systems.`,
    '',
    `I would welcome the chance to discuss how that background maps to ${role.company}'s priorities for this team.`,
    '',
    `Best,`,
    `Sav Banerjee`
  ].join('\n');
}

function safeSlug(value) {
  return String(value || 'role')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90);
}
