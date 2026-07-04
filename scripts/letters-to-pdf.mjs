#!/usr/bin/env node
/**
 * Cover-letter Markdown → clean ATS PDF (Arial 11pt, letterhead, 1in margins).
 * Renders via the pre-installed Chromium. Run: node scripts/letters-to-pdf.mjs
 */
import { readFile, writeFile } from 'fs/promises';
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'output', 'cover-letters');

const LETTERS = [
  { md: 'Pacvue_VPAIStrategyDelivery_2026-07-02.md',        out: 'Pacvue_VP_AI_Strategy_Delivery_CoverLetter.pdf' },
  { md: 'JPMorganChase_ProductStrategyDirector_GTM_2026-07-02.md', out: 'JPMorgan_Product_Strategy_Director_GTM_CoverLetter.pdf' },
  { md: 'Anthropic_PartnerSolutionsArchitect_2026-07-02.md', out: 'Anthropic_Partner_Solutions_Architect_CoverLetter.pdf' },
  { md: 'IABTechLab_HeadOfAgenticTechnologies_2026-07-02.md', out: 'IAB_TechLab_Head_Agentic_Technologies_CoverLetter.pdf' },
];

// Name + contact come from config/candidate.json (gitignored — PII stays local,
// never hardcoded in this public repo). Falls back to placeholders if absent.
async function loadProfile() {
  try {
    const c = JSON.parse(await readFile(join(ROOT, 'config', 'candidate.json'), 'utf8'));
    const contact = [c.location, c.phone, c.email, c.linkedin, c.websites?.[0]].filter(Boolean).join(' · ');
    return { name: c.name || 'Your Name', contact: contact || 'City, State · you@example.com' };
  } catch {
    return { name: 'Your Name', contact: 'City, State · you@example.com · linkedin.com/in/you' };
  }
}
const PROFILE = await loadProfile();

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

/** Take the letter body (after the first `---`), drop the trailing contact line. */
function bodyOf(raw) {
  let lines = raw.split(/\n---\n/).slice(1).join('\n---\n').trim().split('\n');
  while (lines.length && /(?:ensolabs|linkedin\.com|\d{3}-\d{3}-\d{4})/.test(lines[lines.length - 1])) lines.pop();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n').trim();
}

/** Blocks → <p>/<ul>. Bullet block = every line starts with "- ". */
function toHtml(body) {
  return body.split(/\n\s*\n/).map((block) => {
    const rows = block.split('\n');
    if (rows.every((r) => /^[-•]\s+/.test(r.trim()))) {
      return '<ul>' + rows.map((r) => `<li>${inline(r.replace(/^[-•]\s+/, ''))}</li>`).join('') + '</ul>';
    }
    return `<p>${rows.map(inline).join('<br>')}</p>`;
  }).join('\n');
}

const page_html = (bodyHtml) => `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: Letter; margin: 1in; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11pt; line-height: 1.5; color: #111; }
  .name { font-size: 17pt; font-weight: 700; letter-spacing: .3px; }
  .contact { font-size: 9.5pt; color: #555; margin: 2px 0 18px; }
  hr { border: 0; border-top: 1px solid #ccc; margin: 0 0 18px; }
  p { margin: 0 0 11pt; }
  ul { margin: 0 0 11pt; padding-left: 18px; }
  li { margin: 0 0 5pt; }
  strong { font-weight: 700; }
</style></head><body>
  <div class="name">${PROFILE.name}</div>
  <div class="contact">${PROFILE.contact}</div>
  <hr>
  ${bodyHtml}
</body></html>`;

// Use the pre-installed Chromium (env ships 1194; don't run `playwright install`).
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
for (const L of LETTERS) {
  const raw = await readFile(join(DIR, L.md), 'utf8');
  await page.setContent(page_html(toHtml(bodyOf(raw))), { waitUntil: 'load' });
  await page.pdf({ path: join(DIR, L.out), format: 'Letter', printBackground: true });
  console.log(`✓ ${L.out}`);
}
await browser.close();
console.log('\nDone — 4 PDFs in output/cover-letters/');
