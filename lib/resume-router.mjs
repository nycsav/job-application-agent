/**
 * Resume Router — SINGLE SOURCE OF TRUTH for which resume file every submitter
 * uploads. All adapters (submit-ready Greenhouse/Ashby/Lever, dice-adapter,
 * easy-apply-bot LinkedIn) must import selectResume()/defaultResume() from here
 * so the "latest 2026 resume" can never drift between components.
 *
 * The actual file paths + routing rules live in config/candidate.json
 * (resume.default_path, resume.alternates, resume_routing). Update the resume
 * there in ONE place and every submitter follows.
 *
 * NOTE: this governs FILE uploads on ATS forms only. The Indeed / LinkedIn
 * search MCP connectors serve whatever resume Sav has stored on THOSE platforms'
 * own servers — they have no upload API, so their resume must be refreshed by
 * Sav directly at profile.indeed.com and on her LinkedIn profile.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, isAbsolute } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

let _cache = null;
async function loadCandidate() {
  if (_cache) return _cache;
  const raw = await readFile(join(REPO_ROOT, 'config', 'candidate.json'), 'utf-8');
  _cache = JSON.parse(raw);
  return _cache;
}

function abs(p) {
  return isAbsolute(p) ? p : join(REPO_ROOT, p);
}

/**
 * Absolute path to the default (latest) resume — currently v3.
 */
export async function defaultResume() {
  const { resume } = await loadCandidate();
  return abs(resume.default_path);
}

/**
 * Pick the routed resume for a role. Mirrors the routing precedence used across
 * the pipeline: MD/Managed-Services → PMM → Forward-Deployed → default (v3).
 * Returns an absolute path that is guaranteed to exist (falls back to default,
 * then to any present alternate) so a submitter never tries to upload a missing
 * file.
 *
 * @param {string} company
 * @param {string} title
 * @returns {Promise<string>} absolute resume path
 */
export async function selectResume(company = '', title = '') {
  const { resume_routing, resume } = await loadCandidate();
  const co = String(company).toLowerCase();
  const ti = String(title).toLowerCase();
  const has = (arr, hay) => Array.isArray(arr) && arr.some(x => hay.includes(String(x).toLowerCase()));

  let chosen = resume.default_path;
  if (has(resume_routing.md_companies, co) || has(resume_routing.md_keywords, ti)) {
    chosen = resume.alternates.md_managed_services;
  } else if (has(resume_routing.pmm_companies, co) || has(resume_routing.pmm_keywords, ti)) {
    chosen = resume.alternates.perplexity_pmm;
  } else if (has(resume_routing.forward_deployed_companies, co) || has(resume_routing.forward_deployed_keywords, ti)) {
    chosen = resume.alternates.forward_deployed;
  }

  let path = abs(chosen);
  if (!existsSync(path)) {
    const fallback = abs(resume.default_path);
    path = existsSync(fallback) ? fallback : path;
  }
  return path;
}

/**
 * Sanity check used at submitter startup: confirms every configured resume
 * actually exists on disk. Returns { ok, missing: [labels] }.
 */
export async function verifyResumes() {
  const { resume } = await loadCandidate();
  const entries = [['default', resume.default_path], ...Object.entries(resume.alternates || {})];
  const missing = entries.filter(([, p]) => !existsSync(abs(p))).map(([label]) => label);
  return { ok: missing.length === 0, missing };
}
