/**
 * Template Engine — merges candidate.json + role config into filled templates
 * No individual files saved. Returns strings for direct docx conversion.
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

export async function loadCandidate() {
  const raw = await readFile(join(ROOT, 'config/candidate.json'), 'utf-8');
  return JSON.parse(raw);
}

export async function loadRoles() {
  const raw = await readFile(join(ROOT, 'config/roles.json'), 'utf-8');
  return JSON.parse(raw);
}

export async function loadTemplate(name) {
  return readFile(join(ROOT, `templates/${name}`), 'utf-8');
}

/**
 * Default summary from candidate profile
 */
function defaultSummary(c) {
  return `Claude Certified Architect and AI transformation leader with ${c.years_experience} years of enterprise consulting experience, now building production agentic AI systems on Claude and MCP architecture. Proven ${c.verified_metrics.pilot_to_production_rate} pilot-to-production conversion rate across Fortune 500 engagements. Designed and deployed financial AI agents on Claude before Anthropic's financial services launch. Combines deep technical architecture expertise with enterprise delivery discipline — from LLM evaluation and RAG pipelines to multi-agent orchestration and AI Center of Excellence design.`;
}

function defaultCompetencies(c) {
  return 'Claude Architecture | Model Context Protocol (MCP) | Agentic AI Systems | Enterprise AI Deployment | Pilot-to-Production Strategy | AI Center of Excellence Design | LLM Evaluation | RAG Architecture | Multi-Agent Systems | Financial AI Applications | Production AI Operations | Technical Solution Design | Stakeholder & Executive Communication';
}

/**
 * Format certifications list
 */
function formatCertifications(c) {
  return c.certifications
    .map(cert => `- **${cert.name}** — ${cert.org}, ${cert.year || cert.date}`)
    .join('\n');
}

/**
 * Format experience section
 */
function formatExperience(c, role) {
  return c.experience.map(exp => {
    const header = `### ${exp.title} | ${exp.company}`;
    const dateLine = exp.dates ? `**${exp.location} | ${exp.dates}**` : `**${exp.location}**`;
    const bullets = exp.bullets.map(b => `- ${b}`).join('\n');
    return `${header}\n${dateLine}\n\n${bullets}`;
  }).join('\n\n');
}

/**
 * Format portfolio section based on role's portfolio_focus
 */
function formatPortfolio(c, role) {
  const urls = c.portfolio_urls;
  const focus = role.portfolio_focus || ['studio', 'trading_terminal', 'enterprise_ai', 'github'];
  const labels = {
    studio: `**Enso Labs Studio:** [${urls.studio}](https://${urls.studio}) — Production AI transformation practice`,
    trading_terminal: `**Financial AI on Claude + MCP:** [${urls.trading_terminal}](https://${urls.trading_terminal}) — Live trading intelligence system`,
    enterprise_ai: `**Enterprise AI Enablement:** [${urls.enterprise_ai}](https://${urls.enterprise_ai}) — Fortune 500 deployment methodology`,
    healthcare: `**Healthcare AI:** [${urls.healthcare}](https://${urls.healthcare}) — AI Center of Excellence for Pharma`,
    content_engine: `**signal2noise:** [${urls.content_engine}](https://${urls.content_engine}) — AI content intelligence engine`,
    github: `**GitHub:** [${urls.github}](https://${urls.github}) — Open-source projects and builder portfolio`
  };
  return focus.map(key => `- ${labels[key]}`).filter(Boolean).join('\n');
}

/**
 * Generate a filled resume markdown string
 */
export async function generateResume(roleId) {
  const candidate = await loadCandidate();
  const { roles } = await loadRoles();
  const role = roles.find(r => r.id === roleId);
  if (!role) throw new Error(`Role not found: ${roleId}`);

  let template = await loadTemplate('master_resume.md');

  const replacements = {
    '{{NAME}}': candidate.name,
    '{{LOCATION}}': candidate.location,
    '{{EMAIL}}': candidate.email,
    '{{PHONE}}': candidate.phone,
    '{{LINKEDIN}}': candidate.linkedin,
    '{{WEBSITE_PRIMARY}}': candidate.websites[0],
    '{{WEBSITE_SECONDARY}}': candidate.websites[1] || '',
    '{{SUMMARY}}': role.summary_override || defaultSummary(candidate),
    '{{COMPETENCIES}}': role.competencies_override || defaultCompetencies(candidate),
    '{{CERTIFICATIONS}}': formatCertifications(candidate),
    '{{EXPERIENCE}}': formatExperience(candidate, role),
    '{{PORTFOLIO}}': formatPortfolio(candidate, role),
    '{{EDUCATION}}': `**${candidate.education.degree}** — ${candidate.education.school}`
  };

  for (const [key, value] of Object.entries(replacements)) {
    template = template.replaceAll(key, value);
  }

  return { markdown: template, role, candidate };
}

/**
 * Generate a filled cover letter markdown string
 */
export async function generateCoverLetter(roleId) {
  const candidate = await loadCandidate();
  const { roles } = await loadRoles();
  const role = roles.find(r => r.id === roleId);
  if (!role) throw new Error(`Role not found: ${roleId}`);

  const hooks = role.cover_letter_hooks;
  if (!hooks) throw new Error(`No cover letter hooks for: ${roleId}`);

  let template = await loadTemplate('master_cover_letter.md');

  // Build the "why fit" sections with bold headers
  const whyFitSections = hooks.why_fit.map((point, i) => {
    return `**${point}**`;
  }).join('\n\n');

  // Portfolio CTA
  const urls = candidate.portfolio_urls;
  const focus = role.portfolio_focus || ['studio'];
  const primaryUrl = urls[focus[0]] || urls.studio;
  const portfolioCta = `I'd welcome the chance to walk through the live systems at ${primaryUrl}. Everything I'm describing is running in production, not hypothetical.`;

  const replacements = {
    '{{NAME}}': candidate.name,
    '{{LOCATION}}': candidate.location,
    '{{EMAIL}}': candidate.email,
    '{{PHONE}}': candidate.phone,
    '{{LINKEDIN}}': candidate.linkedin,
    '{{WEBSITE_PRIMARY}}': candidate.websites[0],
    '{{COMPANY}}': role.company,
    '{{TITLE}}': role.title,
    '{{OPENER}}': hooks.opener,
    '{{ROLE_CONTEXT}}': `designing AI-powered architectures for enterprise customers and getting them to production`,
    '{{WHY_FIT_SECTIONS}}': whyFitSections,
    '{{PORTFOLIO_CTA}}': portfolioCta,
    '{{CLOSER}}': hooks.closer
  };

  for (const [key, value] of Object.entries(replacements)) {
    template = template.replaceAll(key, value);
  }

  return { markdown: template, role, candidate };
}

/**
 * List all role IDs
 */
export async function listRoles() {
  const { roles } = await loadRoles();
  return roles.map(r => ({ id: r.id, company: r.company, title: r.title, status: r.status, score: r.score }));
}
