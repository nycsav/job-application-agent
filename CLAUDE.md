# Job Application Agent

Automated job application pipeline that scans, scores, generates materials, and submits applications — with human-in-the-loop approval before every submission.

## Owner
Sav Banerjee — sav@ensopartners.co

## Architecture

```
        ┌──────────────────────────┐
        │       Scanner Agent      │
        │  (8 AM & 5 PM weekdays)    │
        ├──────────┬───────────────┤
        │ LinkedIn │ Career Pages  │
        │ Indeed   │ (8 companies) │
        │ Gmail    │               │
        └────┬─────┴───────┬───────┘
             │             │
     Score & Filter    Score & Filter
     (skip < 5)        (skip < 5)
             │             │
             ▼             ▼
     ┌──────────────────────────┐
     │      Google Sheet        │
     │  Jobs tab (score 5+)     │
     │  High Profile (score 7+) │
     └────────────┬─────────────┘
                  │ score 8+
                  ▼
     ┌──────────────────────────┐
     │    Materials Agent       │
     │  (auto-triggered)        │
     │  Resume + Cover Letter   │
     └────────────┬─────────────┘
                  │
                  ▼
     ┌──────────────────────────┐
     │    Submitter Agent       │
     │  (manual trigger only)   │
     │  Human approves submit   │
     └──────────────────────────┘
```

## 3 Agents

### 1. Scanner Agent (`agents/scanner.mjs`)
- Runs at 8 AM & 5 PM weekdays via Claude Code Routine
- **Source 1 — Gmail**: Scans LinkedIn alerts, Indeed alerts, recruiter emails using 4 Gmail search queries
- **Source 2 — Career pages**: Scrapes 8 target company career sites (Anthropic, OpenAI, DeepMind, Cuesta, McKinsey, BCG, Bain, Goldman Sachs)
- Scores every role 0-10 using: title match (0-3), skill overlap (0-3), industry fit (0-2), location (0-1), compensation signal (0-1)
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
- **Google Sheet**: Sav Job Tracker 2026 (ID: `1Wd0x_0fEAyScgMKB9neneuMIo3Sgln-CMytWMF8m6eI`)
  - "Jobs" tab: all tracked roles (score 5+)
  - "High Profile" tab: score 7+ roles
- **Google Drive**: Job Applications folder (ID: `1OOsMcQMegAUg5Ezy47rqiPh7ZAnBZHto`) — active since May 7, all materials land here
- **Gmail**: sav.banerjee@gmail.com — for scanning LinkedIn/Indeed alerts (briefing emails sent to sav@ensopartners.co)
- **Playwright MCP**: For browser automation (Submitter Agent only)
- **Apps Script**: "Job Alert Scanner" project also runs in Google (separate from this pipeline)
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
│   ├── scanner.mjs               # Career page + email scanner + scorer
│   ├── materials.mjs             # Resume/cover letter generator
│   └── submitter.mjs             # Form filler with human gate
│
├── config/
│   ├── candidate.json            # Sav's profile, metrics, clients
│   └── roles.json                # All tracked roles + per-role customizations
│
├── lib/
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
