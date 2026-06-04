# Auto-Pipeline Routine — Scan → Score → Materials → Track

**Schedule:** `0 8,17 * * 1-5` (8 AM & 5 PM weekdays)
**Owner:** Sav Banerjee — sav@ensopartners.co

---

## Pre-Flight

1. Read `config/pipeline.json` for webhook URL, sheet ID, drive folder ID
2. Read `config/resume_map.json` for resume matching clusters
3. Read `config/candidate.json` for candidate profile and verified metrics
4. Import scoring from `agents/auto-pipeline.mjs`:
   - `scoreRole`, `matchResume`, `buildHookGenerationContext`
   - `generateCoverLetterDirect`, `buildSheetRow`, `buildNotionProperties`
   - `generateBriefingEmail`, `EXCLUDE_COMPANIES`

---

## Step 1: Scan Gmail for Job Alerts

Run each of these Gmail searches using the Gmail MCP (`search_threads`):

```
subject:(VP AI OR Director AI OR Head of AI OR Chief AI Officer) newer_than:8h -label:JobAgent/Processed
from:linkedin.com subject:(VP OR Director OR Head) subject:(AI OR artificial intelligence) newer_than:8h -label:JobAgent/Processed
subject:(Solutions Architect AI OR AI Architect OR Principal AI Engineer OR Applied AI) newer_than:8h -label:JobAgent/Processed
from:linkedin.com subject:(architect OR engineer OR principal) subject:(AI OR ML OR LLM) newer_than:8h -label:JobAgent/Processed
subject:(Partner Director AI OR Alliance Manager OR BD AI OR Strategic Partnerships AI) newer_than:8h -label:JobAgent/Processed
subject:(AI Strategy Consultant OR AI Advisory OR Strategy Director AI OR Management Consulting AI) newer_than:8h -label:JobAgent/Processed
from:(recruiter OR talent OR hiring) subject:(AI OR artificial intelligence OR opportunity) newer_than:8h -label:JobAgent/Processed
from:indeed.com subject:(job OR alert OR recommendation) subject:(AI OR strategy OR director OR VP) newer_than:8h -label:JobAgent/Processed
```

Deduplicate threads across queries (same thread_id = same alert).

---

## Step 2: Extract Job Details

For each unique thread:
1. Read the thread with `get_thread` (use MINIMAL format to stay under token limits)
2. Parse the email body to extract:
   - **job_title**: The role title
   - **company**: The hiring company
   - **location**: City/state or "Remote"
   - **apply_url**: The application link (if present)
   - **description**: Job description text or snippet
   - **source**: "LinkedIn Alert", "Indeed Alert", "Recruiter Email", etc.
3. If the email is a LinkedIn digest with multiple roles, extract EACH role separately
4. If you can get a full JD URL, use `web_fetch` to pull the complete description

---

## Step 3: Score & Filter

For each extracted role:
1. **Exclusion check**: Skip if company matches EXCLUDE_COMPANIES (Perplexity, BOI, Board of Innovation)
2. **Score**: Call `scoreRole({ title, company, location, description })` → returns `{ score, breakdown, matchedSkills }`
3. **Score gate**: Skip if score < 5
4. **Dedup check**: Call `checkDuplicate(company, title)` via sheet-writer.mjs → skip if duplicate

Track stats: `emails_scanned`, `roles_extracted`, `passed_scoring`, `duplicates_blocked`, `exclusions_blocked`

---

## Step 4: Match Resume

For each qualifying role:
1. Call `matchResume(role, resumeMap)` → returns `{ cluster, file, angle }`
2. Clusters: `ai_builder`, `ai_advisory`, `ai_partnerships`, `product_marketing`
3. The `file` path points to the pre-approved PDF in `materials/resumes/`

---

## Step 5: Generate Cover Letter (Score 8+ Only)

For roles scoring 8+:
1. Call `buildHookGenerationContext(role, candidate, resumeMatch.angle)`
2. Use the returned `system` and `prompt` to generate cover letter hooks as JSON:
   ```json
   {
     "opener": "...",
     "why_fit": ["...", "...", "...", "..."],
     "closer": "..."
   }
   ```
3. **Quality check the hooks:**
   - opener must be specific, not generic
   - why_fit must include at least one exact metric from candidate.json
   - closer must reference the specific company/role
   - Never mention Gore by name (use "Global Materials Manufacturer")
4. Call `generateCoverLetterDirect(role, hooks, candidate)` → markdown string
5. Call `markdownToDocx(markdown)` → Buffer
6. Generate filename: `Sav_Banerjee_[Company]_[Title]_CoverLetter.docx`

---

## Step 6: Upload to Google Drive

For each role with generated materials:
1. Upload the cover letter .docx to Google Drive using the Drive MCP (`create_file`)
   - Parent folder: `1OOsMcQMegAUg5Ezy47rqiPh7ZAnBZHto` (Job Applications folder)
   - Or the monthly subfolder if one exists (e.g., "Job Applications - May 2026")
2. Note: Resume PDFs are pre-approved and already exist. Include the path reference, don't re-upload.
3. Save the Drive file URLs for sheet/Notion updates.

---

## Step 7: Write to Google Sheet + Notion

### Google Sheet
For each qualifying role (score 5+):
1. Build row data with `buildSheetRow(role, resumeMatch, driveLinks)`
2. Call `appendRow(rowData)` via sheet-writer.mjs
3. Score 7+ roles should also go to the "High Profile" tab (if tab-aware writing is available)

### Notion
For each qualifying role (score 5+):
1. Build properties with `buildNotionProperties(role, resumeMatch)`
2. Use Notion MCP `notion-create-pages` with:
   - `data_source_id`: `931eceb1-d35d-46ca-9d4a-7fbfa48d3f99` (Career Command Center)
   - Properties from the builder function

---

## Step 8: Send Briefing Email

1. Call `generateBriefingEmail(results, stats)` to build the email body
2. Use Gmail MCP `create_draft` with:
   - **To:** sav@ensopartners.co
   - **Subject:** `Job Agent: [date] — [n] new roles ([tier1_count] urgent)`
   - **Body:** The generated briefing
3. If Gmail write permissions are available, send immediately. Otherwise, create as draft.

---

## Step 9: Label Processed Threads

If Gmail write permissions are available:
1. Label each processed thread with `JobAgent/Processed` using `label_thread`
2. This prevents re-scanning the same alerts next run

If write permissions are NOT available:
- Log which thread IDs were processed
- Note in briefing email that manual labeling is needed

---

## Safety Reminders

- **NEVER auto-submit applications** — this agent generates materials only
- **NEVER apply to Perplexity or BOI** — enforced in exclusion check
- **NEVER fabricate metrics** — use exact values from candidate.json
- **NEVER mention Gore by name** — use "Global Materials Manufacturer"
- **Max 7 materials per session** — pause and send summary if exceeded
- If scoring or extraction seems off, log the anomaly and continue
- Take note of context window usage — alert if approaching limits

---

## Post-Run Checklist

- [ ] All qualifying roles written to Sheet
- [ ] All qualifying roles written to Notion
- [ ] Cover letters generated for score 8+ roles
- [ ] Briefing email sent/drafted
- [ ] Stats logged: scanned, extracted, scored, duped, excluded, generated
