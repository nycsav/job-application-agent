/**
 * Shared dedup key for the Career Command Center.
 *
 * WHY: duplicates piled up (Pfizer "Director, Applied AI" ×3, Pacvue "VP, AI
 * Strategy & Delivery" ×2) because each scan/writer staged roles without a
 * shared, normalized key. ANY writer into the Command Center — this repo's
 * scanner AND the notion-career-agent Worker — must compute the SAME key and
 * check it before inserting.
 *
 * Key precedence:
 *   1. Job-board req id from the apply URL (strongest — exact posting).
 *   2. Normalized Company + Title (catches the same role across URL variants).
 */

const STOP = /\b(the|a|an|of|and|inc|llc|ltd|corp|co|group)\b/g;

export function normalize(s = '') {
  return String(s)
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(STOP, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function dedupeKey(company, title) {
  return `${normalize(company)}|${normalize(title)}`;
}

/** Canonical req id from common ATS URLs (greenhouse/lever/workday/linkedin/generic). */
export function urlKey(jobUrl = '') {
  const u = String(jobUrl);
  const m =
    u.match(/greenhouse\.io\/[^/]+\/jobs\/(\d+)/i) ||
    u.match(/lever\.co\/[^/]+\/([0-9a-f-]{36})/i) ||
    u.match(/linkedin\.com\/jobs\/view\/(\d+)/i) ||
    u.match(/jobs?\/(\d{6,})/i);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Returns the existing row that duplicates {company,title,jobUrl}, or null.
 * @param {Array<{company,title,jobUrl,pageId,status}>} existingRows
 */
export function findDuplicate(existingRows = [], { company, title, jobUrl } = {}) {
  const key = dedupeKey(company, title);
  const uk = urlKey(jobUrl);
  for (const r of existingRows) {
    if (uk && urlKey(r.jobUrl) && urlKey(r.jobUrl) === uk) return r; // same req id
    if (dedupeKey(r.company, r.title) === key) return r;             // same company+title
  }
  return null;
}

// quick self-test: node lib/dedup.mjs
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const rows = [
    { company: 'Pfizer', title: 'Director, Applied AI', jobUrl: 'https://pfizer.wd1.myworkdayjobs.com/PfizerCareers', pageId: 'A' },
    { company: 'Pacvue', title: 'VP, AI Strategy & Delivery', jobUrl: 'https://job-boards.greenhouse.io/pacvue/jobs/6011839004', pageId: 'E' },
  ];
  const tests = [
    ['The Pfizer Inc.', 'Director Applied AI', 'https://www.pfizer.com/careers', 'A'],   // company+title hit
    ['Pacvue', 'VP AI Strategy and Delivery', 'https://job-boards.greenhouse.io/pacvue/jobs/6011839004', 'E'], // url hit
    ['Dataiku', 'VP, Reasoning Systems', 'https://job-boards.greenhouse.io/dataiku/jobs/5486496004', null],    // no dup
  ];
  for (const [c, t, u, want] of tests) {
    const hit = findDuplicate(rows, { company: c, title: t, jobUrl: u });
    const got = hit ? hit.pageId : null;
    console.log(`${got === want ? 'PASS' : 'FAIL'}  ${c} / ${t} -> ${got} (want ${want})`);
  }
}
