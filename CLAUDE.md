# Job Application Agent

Automated job application pipeline that scans, scores, generates materials, and submits applications — with human-in-the-loop approval before every submission.

## Owner
Sav Banerjee — sav@ensopartners.co

## Architecture

```
        ┌────────────────────────────────────┐
        │           Scanner Agent            │
        │      (8 AM & 5 PM weekdays)        │
        ├──────────┬───────────────┬─────────┤
        │ LinkedIn │ Career Pages  │Substack │
        │ Indeed   │ (8 companies) │RSS (6   │
        │ Gmail    │               │newsltrs)│
        └────┬─────┴───────┬───────┴────┬────┘
             │             │            │
     Score & Filter    Score & Filter    Score & Filter
     (skip < 5)        (skip < 5)       (skip < 5)
             │             │            │
             ▼             ▼            ▼
     ┌──────────────────────────────────┐
     │  Notion Career Command Center   │  ← PRIMARY (since 2026-05-20)
     │  Dedup · Status · Materials     │
     │  Score 5+ tracked · 7+ priority │
     └────────────┬─────────────────────┘
                  │ score 8+
                  ▼
     ┌──────────────────────────┐
     │    Materials Agent       │
     │  (auto-triggered)        │
     │  Resume + Cover Letter   │
     │  Upload → Notion pages   │
     └────────────┬─────────────┘
                  │
                  ▼
     ┌──────────────────────────┐
     │    Submitter Agent       │
     │  (manual trigger only)   │
     │  Human approves submit   │
     └──────────────────────────┘

     ┌──────────────────────────┐
     │  Google Sheet (ARCHIVE)  │  ← Read-only backup, being retired
     │  Google Drive (LEGACY)   │
     └──────────────────────────┘
```

## 3 Agents

### 1. Scanner Agent (`agents/scanner.mjs` + `agents/substack-scanner.mjs`)
- Runs at 8 AM & 5 PM weekdays via Claude Code Routine
- **Source 1 — Gmail**: Scans LinkedIn alerts, Indeed alerts, recruiter emails using 4 Gmail search queries
- **Source 2 — Career pages**: Scrapes 8 target company career sites (Anthropic, OpenAI, DeepMind, Cuesta, McKinsey, BCG, Bain, Goldman Sachs)
- **Source 3 — Personal Gmail API** (added 2026-05-21): Direct OAuth2 connection to sav.banerjee@gmail.com via `agents/personal-gmail-scanner.mjs`. Replaces dead Composio MCP. Auth setup: `lib/gmail-auth.mjs`. Credentials: `config/gmail-credentials.json` + `config/gmail-token.json`. Supports `--from`, `--query`, `--hours` flags. Covers recruiter emails (Jack, Jill, etc.) that the forwarding filter misses.
- **Source 4 — Substack RSS** (added 2026-05-20): Polls 6 curated VC/operator newsletters (a16z Build, Lenny's, Generalist, Not Boring, Stratechery, Every) via `/feed`. No auth required. Extracts founding-team roles from hiring posts. Currently in **Phase 1 shadow mode** — discoveries logged to `reports/substack-discoveries.log`, not yet pushed to the sheet. Config: `config/substack-sources.json`. Plan: `SUBSTACK-PLAN.md`. Promote to Phase 2 by flipping `SUBSTACK_SHADOW_MODE = false` in `orchestrator.mjs`.
- **Source 5 — JobRight** (added 2026-06-02): Jobright.ai digest emails (sender `eric@jobright.com`, subject "You are Invited! …"). Curated AI-transformation / GTM-engineer role lists with comp + remote flags. NOTE: these arrive in the PERSONAL inbox (sav.banerjee@gmail.com), so they are scanned via `agents/personal-gmail-scanner.mjs --from jobright.com`, NOT the connected work Gmail MCP. Same `scoreRole()` + hard filters apply.
- **Source 6 — Ladders** (added 2026-06-02): `jobs@my.theladders.com` digests delivered to the ensopartners.co inbox (connected Gmail MCP). Parse "Title $X–$Y* | Company | Location" rows. Same `scoreRole()` + hard filters apply.
- Scores every role 0-10 using: title match (0-3), skill overlap (0-3), industry fit (0-2), location (0-1), compensation signal (0-1) — **same `scoreRole()` function reused across all sources**
- **Score thresholds**:
  - < 5 → silent skip (don't add to sheet)
  - 5-6 → Jobs tab only (passive tracking)
  - 7+ → Jobs + High Profile tab (active monitoring)
  - 8+ → auto-generate materials immediately
- Sends email summary after each scan with urgency tiers

### 2. Materials Agent (`agents/materials.mjs`)
- Triggered automatically when Scanner finds score 8+ roles
- Reads master templates + role-specific hooks from `config/roles.json`
- Generates tailored resume + cover letter in memory
- Converts to ATS-optimized .docx (Arial 11pt, single column, no graphics)
- Uploads directly to Google Drive (no local file sprawl)
- Updates Google Sheet with Drive links

### 3. Submitter Agent (`agents/submitter.mjs`)
- Manual trigger only — NEVER auto-scheduled
- Platform-specific form strategies: Greenhouse, Ashby, Lever, Google Careers, custom
- Fills all form fields from candidate profile
- **MANDATORY STOP before submit** — takes screenshot, asks for explicit approval
- PreToolBatch hook blocks any click on Submit/Apply buttons without confirmation
- Records confirmation numbers and updates tracker

## Parallel Manager (orchestrator) — `agents/manager.mjs`
The discovery side runs as a **manager + parallel workers** pattern (see
`docs/parallel-agent-architecture.html` + `docs/AGENT-MANAGER-DESIGN.md`). The manager:
delegates to the parallel source specialists (`agents/parallel-scanner.mjs`), runs an
**acceptance check on every worker output**, dedups through the **one keyed writer**
(`keyedStage()` in `lib/notion-writer.mjs`, using the shared `dedupeKey()` from
`lib/dedup.mjs`), tailors (resume pick via `lib/resume-picker.mjs`), and stages a
**click-ready shortlist** + a **"needs you"** bucket — with an `Agent Trail` on every write.
It **owns the human gate and never submits** (Lane A). Run: `npm run manager` (fixture-backed,
no creds) or `npm run pipeline:parallel`. Submit stays human-gated via `agents/notion-submitter.mjs`.

## Score Thresholds (Constants in scanner.mjs)
```
MINIMUM_SHEET_SCORE = 5      // Below this = don't track
HIGH_PROFILE_SCORE = 7       // High Profile tab + active monitoring
AUTO_MATERIALS_SCORE = 8     // Auto-generate resume + cover letter
```

## Exclusions
- **Perplexity**: Never scan, score, or apply. Sav handles personally.
- **BOI (Board of Innovation)**: Never scan, score, or apply. Sav's former employer — permanently blacklisted.
- Enforced via EXCLUDE_COMPANIES array in scanner.mjs and exclude_companies in candidate.json

## Connected Services

### PRIMARY (Notion — since 2026-05-20)
- **Notion Career Command Center**: Database ID `8ce2a0e3-0ab3-4416-bcfe-81295f4e4991`
  - Data source ID: `931eceb1-d35d-46ca-9d4a-7fbfa48d3f99`
  - 20 properties: Job Title, Company, Fit Score, Status, Priority, Source, Source Tier, Automation Tier, Pillar, Location, Strengths, Gaps, ATS Keywords, Fit Reason, Salary Range, Job URL, Portfolio Links, Applied Date, Urgent, Created
  - All dedup checks, status tracking, and materials linking go through Notion
  - URL: https://www.notion.so/8ce2a0e30ab34416bcfe81295f4e4991
- **Notion MCP**: For all DB reads/writes via notion-create-pages, notion-search, notion-update-page
- **Notion File Upload API**: For .docx resume/cover letter storage on Notion pages

### ACTIVE
- **Gmail**: sav.banerjee@gmail.com — for scanning LinkedIn/Indeed alerts (briefing emails sent TO sav@ensopartners.co — NEVER mix directions)
- **Playwright MCP**: For browser automation (Submitter Agent only)

### ARCHIVE (read-only, being retired)
- **Google Sheet**: Sav Job Tracker 2026 (ID: `1Wd0x_0fEAyScgMKB9neneuMIo3Sgln-CMytWMF8m6eI`) — read-only backup
- **Google Drive**: Job Applications folder (ID: `1OOsMcQMegAUg5Ezy47rqiPh7ZAnBZHto`) — legacy materials storage
- **Apps Script**: "Job Alert Scanner" — separate project, still running independently
  - Project URL: https://script.google.com/u/2/home/projects/1saSsIzHuqNocF0BoGGeBC0qJnMlq3IWlSxJVoawDi6ARkZPlkZmuB-B_/edit

## File Structure
```
job-application-agent/
├── CLAUDE.md                     # This file
├── package.json                  # Dependencies (docx, googleapis)
├── orchestrator.mjs              # Main entry — chains all 3 agents
├── SETUP.md                      # Full setup guide with CLI commands
├── claude-settings.json          # Copy to .claude/settings.json
│
├── agents/
│   ├── scanner.mjs               # Career page + email scanner + scorer (exports scoreRole)
│   ├── personal-gmail-scanner.mjs # Direct Gmail API scanner for sav.banerjee@gmail.com (Source 3)
│   ├── substack-scanner.mjs      # Substack RSS scanner — Source 4 (shadow mode v1)
│   ├── materials.mjs             # Resume/cover letter generator
│   └── submitter.mjs             # Form filler with human gate
│
├── config/
│   ├── candidate.json            # Sav's profile, metrics, clients
│   ├── roles.json                # All tracked roles + per-role customizations
│   └── substack-sources.json     # Curated Substack feed list + extraction hints
│
├── lib/
│   ├── gmail-auth.mjs            # OAuth2 setup + token management for personal Gmail
│   ├── notion-writer.mjs         # PRIMARY: Notion Career Command Center writes, dedup, pre-flight
│   ├── sheet-writer.mjs          # ARCHIVE: Google Sheet writes (read-only fallback)
│   ├── safety-guards.mjs         # Pre-submission validation (now Notion-first)
│   ├── template-engine.mjs       # Merges candidate + role → filled markdown
│   └── docx-builder.mjs          # Markdown → ATS-optimized .docx
│
├── templates/
│   ├── master_resume.md          # Resume template with {{placeholders}}
│   └── master_cover_letter.md    # Cover letter template with {{placeholders}}
│
├── routines/
│   ├── daily-scan.md             # Routine: multi-source scanning (every 4h)
│   ├── generate-materials.md     # Routine: materials generation
│   └── submit-applications.md    # Routine: form submission (manual)
│
└── apps-script/
    └── SCORE_FILTER_PATCH.md     # Patch for the Google Apps Script scanner
```

## Template System (No File Sprawl)
Instead of saving individual .docx files per role:
- **1 master resume template** + **1 master cover letter template** (in `templates/`)
- **1 roles.json** with per-role customizations (hooks, overrides)
- **1 candidate.json** with the full profile
- Documents generated **in-memory** and uploaded **directly to Google Drive**

## Quality Rules
- Use EXACT metrics from `candidate.json` verified_metrics — never round or approximate
- Every cover letter must reference at least one live URL (ensolabs.ai/work/*)
- Resume must be single-page if possible
- Cover letter under 400 words
- Never mention confidential client names (use "Global Materials Manufacturer" for Gore)

## Claude Code Setup (One-Time)
```bash
# 1. Install dependencies
cd ~/Projects/job-application-agent
npm install

# 2. Install Playwright MCP
claude mcp add playwright -- npx @anthropic/playwright-mcp@latest

# 3. Copy settings
mkdir -p .claude
cp claude-settings.json .claude/settings.json

# 4. Create the scan routine (8 AM & 5 PM weekdays)
claude routine add job-scanner \
  --schedule "0 8,17 * * 1-5" \
  --prompt "$(cat routines/daily-scan.md)"

# 5. Test with a manual scan
claude "Read routines/daily-scan.md and execute the steps"
```

## Saw's Candidate Profile (Summary)
- 15+ years enterprise AI strategy and consulting
- Founder: Enso Partners + Enso Labs (2020-Present)
- Fortune 500 clients: Citi, JPMorgan Chase, AmEx, Google, Microsoft, T-Mobile
- Agency leadership: McCann, RAPP, Omnicom, Rokkan (Publicis)
- Healthcare: Pfizer, Eli Lilly
- Key differentiators: builds production AI systems, human+AI orchestration, team builder (8-15 person teams)
- Location: New York, NY
- Certifications: Perplexity AI Business Fellowship, CrewAI Multi-Agent, Anthropic Claude, Google AI Essentials

## Safety Rules
- NEVER auto-submit applications without human approval
- NEVER apply to Perplexity
- NEVER fabricate metrics or client names
- If CAPTCHA or login required, STOP and ask user
- Take screenshots at every major step for audit trail

## Workflow Safety Guards (Added 2026-05-17)
See `lib/safety-guards.mjs` for full implementation.

### Pre-Submission Logging
Every application gets a tracker row with Status="Queued" BEFORE the submit button is clicked. Only updated to "Applied" after confirmed submission. If submission fails, row stays "Queued" and gets flagged.

### Materials Tracking
- Easy Apply: Resume Link = "LinkedIn Default Profile", Cover Letter = "N/A - Easy Apply"
- Custom applications: Actual Google Drive links to generated .docx files
- Notes column includes materials version and session ID

### Deduplication Gate
Before any submission, check Google Sheet for matching Company + Job Title. If match exists (any status), skip and log "DUPLICATE BLOCKED". Enforced in `preFlightCheck()`.

### Score Gate
No submission proceeds unless the role has a score >= 5 recorded. Roles with undefined/null scores are hard-blocked.

### Batch Limit
Max 7 applications per session. After 7, forced pause — send summary email and wait for explicit user "continue". Prevents runaway bulk submissions.

### Session Isolation
Each session writes a Session ID to the Notes column. Before submitting, check if another session has written rows in the last 30 minutes. If yes, halt and alert user.

### Briefing Email = Single Source of Truth
After every submission batch, send a summary email listing: company, role, score, materials used, confirmation number. LinkedIn confirmation emails are secondary/archivable.
