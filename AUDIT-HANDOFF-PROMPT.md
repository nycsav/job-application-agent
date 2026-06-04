# Job Application Agent — Audit Handoff Prompt

Copy everything below the line into a new Cowork chat with the Job-Application-Agent folder selected.

---

You are continuing work on my Job Application Agent project. A comprehensive audit was just completed. Here is the full context you need.

## Project Overview
This is an automated job application pipeline with 3 agents: Scanner (discovers jobs via Gmail + career pages), Materials (generates resume + cover letter), and Submitter (fills forms with human-in-the-loop gate). Read CLAUDE.md for full architecture.

## What the Audit Found

### BROKEN (P0 — Fix Immediately)

1. **Google Sheet has no programmatic read/write integration**
   - The sheet (ID: `1Wd0x_0fEAyScgMKB9neneuMIo3Sgln-CMytWMF8m6eI`) is referenced everywhere but no MCP or API connection exists to read/write rows programmatically
   - The safety guards in `lib/safety-guards.mjs` depend on reading sheet rows for deduplication, but `sheetRows` is always passed as `[]` in practice
   - **Fix**: Use the Google Drive MCP (`mcp__b2301c0e-*`) which can read/write spreadsheets, or connect a dedicated Sheets MCP

2. **No scheduled routine is actually registered**
   - `routines/daily-scan.md` describes a scan that should run at 8 AM & 5 PM weekdays, but no Claude Code routine or Cowork scheduled task exists
   - The scanner has never run automatically — all scans have been manual
   - **Fix**: Register via `mcp__scheduled-tasks__create_scheduled_task` with cron `0 8,17 * * 1-5`

3. **Gmail confirmation filter not created**
   - Attempted to create a "JobAgent/Confirmations" label but the call timed out
   - LinkedIn and Indeed confirmation emails currently flood both inboxes with no filtering
   - **Fix**: Create the label via Gmail MCP and set up a filter for confirmation emails

### BROKEN (P1 — Fix This Week)

4. **Dual resume system conflict**
   - `config/resume_map.json` says: "Do NOT regenerate resumes. Pick the best match and submit the PDF as-is." It points to 4 pre-approved PDFs in `materials/resumes/`
   - `lib/template-engine.mjs` + `config/roles.json` generates NEW resumes from `templates/master_resume.md` using per-role hooks
   - These two systems contradict each other. The pipeline currently uses the template system.
   - **Fix**: Unify — use PDFs for Easy Apply (Tier 1), templates for custom applications (Tier 2/3). Update `agents/materials.mjs` to check platform tier before deciding which path.
   - **WARNING**: `Sav_Banerjee_Resume_AI_Partnerships.pdf` is only 5,743 bytes — suspiciously small compared to the others (60-96KB). May be incomplete/corrupted. Validate before using.

5. **`config/roles.json` is out of sync with Google Sheet**
   - All 9 roles in roles.json have `status: "materials_ready"` and 0 have `status: "applied"`
   - But applications HAVE been submitted (the May 15 incident involved 28+ Easy Apply submissions)
   - roles.json was never updated after submissions — it's stale
   - **Fix**: Remove status tracking from roles.json entirely. Google Sheet is the single source of truth for application status. roles.json should only store role configs and hooks.

6. **Session isolation is non-functional**
   - `safety-guards.mjs` checks for concurrent sessions by looking at sheet rows written in the last 30 minutes
   - But since sheet reading doesn't work (see #1), this check always passes
   - **Fix**: Depends on fixing #1 first

### WORKING (No Changes Needed)

- **All 6 JavaScript modules** import and execute correctly (scanner.mjs, materials.mjs, submitter.mjs, template-engine.mjs, docx-builder.mjs, safety-guards.mjs)
- **Scoring algorithm** (`scanner.mjs → scoreRole()`) correctly weights title (0-3), skills (0-3), industry (0-2), location (0-1), compensation (0-1) and normalizes to 0-10
- **Safety guards logic** — all preflight checks pass: dedup (exact + fuzzy + case-insensitive), score gate (blocks undefined and <5), exclusion list (blocks Perplexity, BOI), batch limit (caps at 7)
- **Template engine** — generates resume + cover letter with no unfilled `{{placeholders}}`, correct metrics from candidate.json, no confidential client names leaked
- **DOCX builder** — produces valid ZIP/DOCX files with ATS formatting (Arial 11pt, single column)
- **Quality scorecard** (`routines/quality-scorecard.md`) — 100-point rubric, 85+ required for both resume and cover letter
- **Platform strategy matrix** — Greenhouse, Ashby, Lever, Google Careers, and custom platform configs with correct selectors

### NEEDS OPTIMIZATION (P2/P3)

7. **Scoring algorithm calibration**
   - `skill_overlap` checks against 10 candidate skills but most JDs only mention 2-3, so this component rarely scores above 1/3
   - A "VP AI Strategy" role at Anthropic (ideal match) only scores 7/10 in testing
   - **Fix**: Weight matched skills logarithmically or set thresholds (1 match = 1pt, 3+ = 2pts, 5+ = 3pts)

8. **PDF resume validation needed**
   - 4 PDFs in `materials/resumes/`: AI_Builder (60KB), AI_Advisory (96KB), AI_Partnerships (6KB), Product_Marketing (86KB)
   - The Partnerships file at 6KB is likely broken
   - **Fix**: Open each PDF and verify content, regenerate Partnerships if needed

9. **Pipeline dashboard**
   - No visibility into pipeline state without reading roles.json or the sheet manually
   - **Fix**: Build a Cowork artifact that reads the Google Sheet and displays pipeline status with filters

## Safety Context (CRITICAL — Must Be Preserved)

- **All submission activity is currently PAUSED** per my earlier request after the May 15 incident (28+ untracked Easy Apply submissions)
- The May 15 incident led to creation of `lib/safety-guards.mjs` with 7 safety mechanisms
- From my earlier feedback: **don't ask permission for Easy Apply (Tier 1/2) submissions — just submit them.** But DO stop before Tier 3 (Oracle HCM, Workday) and any custom portal submissions.
- NEVER apply to Perplexity (I handle personally) or BOI/Board of Innovation (former employer, permanently blacklisted)
- NEVER fabricate metrics — use exact values from `config/candidate.json → verified_metrics`
- NEVER mention W. L. Gore & Associates by name — always use "Global Materials Manufacturer"
- Max 7 applications per session before forced pause
- Pre-log every application to sheet with Status="Queued" BEFORE clicking submit

## Files Changed in This Audit Session

| File | Change |
|------|--------|
| `lib/safety-guards.mjs` | CREATED — 268 lines, all safety guard functions |
| `agents/submitter.mjs` | EDITED — integrated safety guards into createSubmissionPlan() |
| `routines/daily-scan.md` | EDITED — added 6 new guardrail rules to GUARDRAILS section |
| `CLAUDE.md` | EDITED — added "Workflow Safety Guards" section documenting all 7 mechanisms |

## Recommended Action Plan (Priority Order)

1. **Connect Google Sheets read/write** — test with the Google Drive MCP's spreadsheet tools
2. **Create Gmail confirmation filter** — label "JobAgent/Confirmations" for LinkedIn/Indeed confirmation emails
3. **Unify resume system** — PDFs for Easy Apply, templates for custom apps
4. **Validate the 4 PDF resumes** — especially the 6KB Partnerships file
5. **Clean up roles.json** — remove status field, keep only role configs
6. **Register the daily scan routine** — scheduled task at 8 AM and 5 PM weekdays
7. **Tune scoring algorithm** — fix skill_overlap underweighting
8. **Build pipeline dashboard artifact** — live view of Google Sheet data
9. **Un-pause submissions** — only after items 1-5 are complete

## Your First Task

Start by reading CLAUDE.md and `lib/safety-guards.mjs` to orient yourself, then work through the action plan above starting with #1 (Google Sheets connection). Test each fix before moving to the next.
