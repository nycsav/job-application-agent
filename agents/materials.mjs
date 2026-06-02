#!/usr/bin/env node
/**
 * Materials Generator Agent
 *
 * WHAT IT DOES:
 * RESUME STRATEGY (two-tier):
 *   Tier 1: Use pre-approved PDFs from config/resume_map.json (preferred)
 *   Tier 2: Generate custom .docx via template engine (only if no PDF cluster fits)
 *
 * COVER LETTERS: Always generated fresh per role via template engine.
 *
 * STATUS: Role status lives in Notion Career Command Center (primary) and
 * Google Sheet (read-only archive). Check Notion via lib/notion-writer.mjs.
 *
 * DESIGNED FOR: Claude Code subagent (triggered by Scanner or Orchestrator)
 */

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { generateResume, generateCoverLetter, loadRoles } from '../lib/template-engine.mjs';
import { markdownToDocx, makeFilename } from '../lib/docx-builder.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/**
 * Generate materials for a single role
 * Returns { resumeBuffer, coverLetterBuffer, resumeFilename, coverLetterFilename }
 */
export async function generateMaterialsForRole(roleId) {
  console.log(`[Materials] Generating for: ${roleId}`);

  // Generate resume
  const { markdown: resumeMd, role, candidate } = await generateResume(roleId);
  const resumeBuffer = await markdownToDocx(resumeMd);
  const resumeFilename = makeFilename(candidate, role, 'Resume');

  // Generate cover letter
  const { markdown: coverMd } = await generateCoverLetter(roleId);
  const coverBuffer = await markdownToDocx(coverMd);
  const coverFilename = makeFilename(candidate, role, 'CoverLetter');

  console.log(`[Materials] Generated: ${resumeFilename}, ${coverFilename}`);

  return {
    roleId,
    resumeBuffer,
    coverLetterBuffer: coverBuffer,
    resumeFilename,
    coverLetterFilename: coverFilename,
    resumeMarkdown: resumeMd,
    coverLetterMarkdown: coverMd
  };
}

/**
 * Generate materials for all pending roles
 */
export async function generateAllPending() {
  const { roles } = await loadRoles();
  // Filter roles that have cover letter hooks defined but no Drive links yet
  const pending = roles.filter(r => r.cover_letter_hooks && !r.drive_resume_url);

  if (pending.length === 0) {
    console.log('[Materials] No pending roles need materials.');
    return [];
  }

  console.log(`[Materials] ${pending.length} roles need materials`);

  const results = [];
  for (const role of pending) {
    try {
      const materials = await generateMaterialsForRole(role.id);
      results.push(materials);
    } catch (err) {
      console.error(`[Materials] Failed for ${role.id}: ${err.message}`);
    }
  }

  return results;
}

/**
 * Update role status in roles.json
 */
export async function updateRoleStatus(roleId, status, extraFields = {}) {
  const rolesPath = join(ROOT, 'config/roles.json');
  const raw = await readFile(rolesPath, 'utf-8');
  const data = JSON.parse(raw);

  const role = data.roles.find(r => r.id === roleId);
  if (role) {
    role.status = status;
    Object.assign(role, extraFields);
    await writeFile(rolesPath, JSON.stringify(data, null, 2));
    console.log(`[Materials] Updated ${roleId} → ${status}`);
  }
}

// ─── Claude Code Routine Specification ───────────────────────────
//
// When triggered by the Scanner or Orchestrator, Claude Code will:
//
// 1. Read config/roles.json
// 2. For each role where status !== 'materials_ready':
//    a. Call generateMaterialsForRole(roleId) to get buffers
//    b. PRIMARY: Upload .docx to Notion page via File Upload API (2-step: upload → attach)
//    c. FALLBACK: Upload to Google Drive folder (legacy, being retired)
//    d. Get the file URLs (Notion page URL or Drive URL)
//    e. Update roles.json with: status='materials_ready', notion_page_url
//    f. Update Notion Career Command Center row with file links
//
// 3. If a new role was added by Scanner with no cover_letter_hooks:
//    a. Read the job description from the career page (web_fetch)
//    b. Use Claude to generate cover_letter_hooks based on:
//       - The job description requirements
//       - The candidate.json profile
//       - The pattern of existing cover_letter_hooks in roles.json
//    c. Save the hooks to roles.json
//    d. Then generate materials as above
//
// PRIMARY: Notion Career Command Center (DB: 8ce2a0e3-0ab3-4416-bcfe-81295f4e4991)
// ARCHIVE: Google Drive folder: 1OOsMcQMegAUg5Ezy47rqiPh7ZAnBZHto (being retired)
// ARCHIVE: Google Sheet: 1Wd0x_0fEAyScgMKB9neneuMIo3Sgln-CMytWMF8m6eI (read-only)

// ─── Standalone execution ────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const roleId = process.argv[2];

  if (roleId) {
    // Generate for specific role
    generateMaterialsForRole(roleId).then(result => {
      console.log(`\nResume: ${result.resumeFilename} (${result.resumeBuffer.length} bytes)`);
      console.log(`Cover:  ${result.coverLetterFilename} (${result.coverLetterBuffer.length} bytes)`);
    }).catch(console.error);
  } else {
    // Generate for all pending
    generateAllPending().then(results => {
      console.log(`\nGenerated materials for ${results.length} roles`);
      results.forEach(r => {
        console.log(`  ${r.roleId}: ${r.resumeFilename}, ${r.coverLetterFilename}`);
      });
    }).catch(console.error);
  }
}
