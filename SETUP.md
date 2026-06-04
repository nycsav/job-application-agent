# Job Engine — Setup Guide

## What This Is

A 3-agent automated job application pipeline built for Claude Code:

1. **Scanner Agent** — Every 4 hours: scans LinkedIn/Indeed emails via Gmail + 8 career pages; scores 0-10; only 5+ goes to sheet; 8+ auto-generates materials
2. **Materials Agent** — Generates tailored resume + cover letter .docx from templates (no file sprawl)
3. **Submitter Agent** — Fills application forms via Playwright, pauses before Submit for your approval

## Architecture

```
        ┌──────────────────────────┐
        │       Scanner Agent      │
        │   (every 4h, weekdays)   │
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

## Quick Start (5 minutes)

### Step 1: Install dependencies

```bash
cd ~/Projects/ensolabs-site/job-engine
npm install
```

### Step 2: Test the template system

```bash
node orchestrator.mjs --status
node orchestrator.mjs --generate
```

### Step 3: Install Playwright MCP in Claude Code

```bash
claude mcp add playwright -- npx @anthropic/playwright-mcp@latest
```

### Step 4: Copy settings to Claude Code

```bash
mkdir -p ~/Projects/ensolabs-site/job-engine/.claude
cp claude-settings.json .claude/settings.json
```

### Step 5: Set up the job scan routine (every 4 hours)

In Claude Code, run:

```
claude routine add job-scanner \
  --schedule "0 8,12,16,20 * * 1-5" \
  --prompt "$(cat routines/daily-scan.md)"
```

Or create it interactively:

```
claude
> /routine create job-scanner
> Paste the contents of routines/daily-scan.md
> Schedule: 0 8,12,16,20 * * 1-5
```

This scans LinkedIn/Indeed emails + career pages 4x daily on weekdays.

### Step 6: Run your first scan manually

```
claude "Read job-engine/routines/daily-scan.md and execute the steps"
```

### Step 7: Submit applications (manual, with approval)

```
claude "Read job-engine/routines/submit-applications.md and execute for the highest-score ready role"
```

## File Structure

```
job-engine/
├── package.json                  # Dependencies (docx, googleapis)
├── orchestrator.mjs              # Main entry — chains all 3 agents
├── SETUP.md                      # This file
├── claude-settings.json          # Copy to .claude/settings.json
│
├── agents/
│   ├── scanner.mjs               # Career page scraper + scorer
│   ├── materials.mjs             # Resume/cover letter generator
│   └── submitter.mjs             # Form filler with human gate
│
├── config/
│   ├── candidate.json            # Your profile, metrics, clients
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
└── routines/
    ├── daily-scan.md             # Claude Code Routine: daily scanning
    ├── generate-materials.md     # Claude Code Routine: materials generation
    └── submit-applications.md    # Claude Code Routine: form submission
```

## How It Works

### No File Sprawl
Instead of saving 14 individual .docx files per batch of roles, this system uses:
- **1 master resume template** + **1 master cover letter template**
- **1 roles.json** with per-role customizations (hooks, overrides)
- **1 candidate.json** with your full profile

Documents are generated **in-memory** and uploaded **directly to Google Drive**. Nothing accumulates locally.

### Adding a New Role
Edit `config/roles.json` and add a new entry:

```json
{
  "id": "company-title-slug",
  "company": "Company Name",
  "title": "Role Title",
  "status": "pending",
  "score": 8,
  "apply_url": "https://...",
  "platform": "greenhouse|ashby|lever|google_careers|custom",
  "cover_letter_hooks": {
    "opener": "...",
    "why_fit": ["...", "...", "...", "..."],
    "closer": "..."
  },
  "portfolio_focus": ["trading_terminal", "enterprise_ai"]
}
```

Then run: `node orchestrator.mjs --generate`

### Human-in-the-Loop
The Submitter Agent **never auto-submits**. It:
1. Fills the form completely
2. Takes a screenshot
3. Asks you "Ready to submit for [Company] — [Title]?"
4. Waits for your "yes" before clicking Submit

This is enforced by a PreToolBatch hook that blocks any click on Submit/Apply buttons.

### Scoring Rubric
Roles are scored 0-10 on:
- Title seniority match (0-3)
- Skill overlap with your profile (0-3)
- Industry fit (0-2)
- Location (NYC/Remote) (0-1)
- Compensation signal (0-1)

Score 8+ = auto-generate materials. Score 7+ = add to tracker. Below 7 = skip.

## Connected Services
- **Google Sheet**: Sav Job Tracker 2026 (ID: 1Wd0x_0fEAyScgMKB9neneuMIo3Sgln-CMytWMF8m6eI)
- **Google Drive**: Job Applications folder (ID: 1OOsMcQMegAUg5Ezy47rqiPh7ZAnBZHto)
- **Gmail**: sav@ensopartners.co (daily briefing emails)
- **Playwright MCP**: For browser automation in Claude Code

## Exclusions
- Perplexity: Do not scan, score, or apply. Saw handles personally.
