# Job Application Agent

> **⚠️ STATUS — 2026-07-22: This repo is legacy/dev. The live production engine is elsewhere, and it WORKS.**
>
> The operating job-search system is the Claude Code **`job-sweep-daily`** scheduled task + the
> **`CLAUDECODEJOBSWEEP.md`** per-site apply wrapper, governed by **`ensolabs-site/CLAUDE.md`**
> (NY-only, comp floors, **7.01–8.9 auto-submit / 9.0+ human-gate**, hard-stops, signature rule).
> It runs on the Mac with a *persistent logged-in Chrome* and submits to employer ATS directly.
> As of 2026-07-22 the Notion Career Command Center shows **55 Applied · 1 Interview (Runway ML) ·
> 8 Approved · 56 Materials Ready**.
>
> Earlier notes in this repo that called autonomous submission "a mirage" were **wrong** — they
> reasoned from this stale repo + a browserless cloud session, not the live engine. Correction:
> gated auto-submit works on Claude Code + persistent Chrome, within the hard-stops (never create
> accounts, enter passwords, solve CAPTCHAs, auto-submit 9.0+, or apply to SF/relocation roles).
>
> **Canonical sources win; this repo defers to them — do not drift.** Reusable pieces kept here:
> `lib/dedup.mjs` (shared dedup key), `lib/resume-picker.mjs`, `lib/notion-queue.mjs`,
> `patches/notion-career-agent-dedup.patch`.
>
> **Real open issue:** ~40 *tracking*-duplicate clusters in Notion (a role logged 2–4× from
> receipt/backfill/scan without a dedup key at creation) — **not** employer double-applies
> (verified: Cohere was 1 application tracked 3×). Fix = apply `lib/dedup.mjs` at row-creation in
> the engine, not manual board surgery.

An automated job application pipeline built on Claude Code that scans job boards, scores roles against your profile, generates tailored materials, and submits applications — with human-in-the-loop approval before every submission.

## Why this exists

Applying to jobs at scale is broken. You either spray-and-pray with a generic resume, or spend 45 minutes per application tailoring materials manually. This agent does the tailoring at scale while keeping you in control of what actually gets submitted.

## How it works

```
Scanner Agent (scheduled)
    ↓ scans LinkedIn alerts, Indeed, career pages via Gmail + MCP
    ↓ scores each role 0-10 against your profile
    ↓ filters: <5 skip, 5-6 track, 7+ high-priority, 8+ auto-generate
    ↓
Materials Agent (auto-triggered for score 8+)
    ↓ selects best resume cluster for the role
    ↓ generates tailored resume + cover letter
    ↓ uploads to Google Drive
    ↓
Submitter Agent (manual trigger only)
    ↓ detects ATS platform (Greenhouse, Lever, etc.)
    ↓ fills form fields from your candidate profile
    ↓ STOPS and asks for your approval before submitting
    ↓ records confirmation in Google Sheet tracker
```

## 3-Tier Submission Strategy

Not all job sites are created equal for automation:

| Tier | Platforms | Method | Friction |
|------|-----------|--------|----------|
| 1 | LinkedIn Easy Apply, Indeed, Dice | MCP / Chrome extension | Lowest — API or simple DOM |
| 2 | Greenhouse, Ashby, Lever | Chrome MCP (DOM automation) | Medium — standardized forms |
| 3 | Oracle HCM, Workday, iCIMS | Manual assist | Highest — native file pickers, CAPTCHAs |

The agent prioritizes Tier 1 applications first, then works through Tier 2, and flags Tier 3 for your manual intervention.

## Resume Cluster System

Instead of one resume, maintain 3-5 cluster variants that emphasize different strengths:

```json
{
  "clusters": {
    "ai_builder": { "emphasis": "production AI systems, technical architecture" },
    "ai_advisory": { "emphasis": "C-suite advisory, transformation strategy" },
    "ai_partnerships": { "emphasis": "strategic alliances, ecosystem development" },
    "product_marketing": { "emphasis": "GTM strategy, product positioning" }
  }
}
```

The Materials Agent automatically selects the best cluster for each role based on JD keyword analysis.

## Setup

### Prerequisites

- [Claude Desktop](https://claude.ai/download) with Claude Code / Cowork mode
- Node.js 18+
- Google account (for Sheets tracker + Drive storage)
- LinkedIn, Indeed accounts

### Quick Start

```bash
# 1. Clone and install
git clone https://github.com/nycsav/job-application-agent.git
cd job-application-agent
npm install

# 2. Create your candidate profile
cp config/candidate.example.json config/candidate.json
# Edit candidate.json with your real data (it's gitignored)

# 3. Add your resume PDFs
mkdir -p materials/resumes
# Place your cluster-variant PDFs here (gitignored)

# 4. Configure Google Sheet tracker
# Create a Google Sheet and update the sheet ID in CLAUDE.md

# 5. Run a manual scan
claude "Read routines/daily-scan.md and execute the steps"
```

### Scheduled Scanning

```bash
# Set up automated scanning (8 AM & 5 PM weekdays)
claude routine add job-scanner \
  --schedule "0 8,17 * * 1-5" \
  --prompt "$(cat routines/daily-scan.md)"
```

## File Structure

```
job-application-agent/
├── agents/
│   ├── scanner.mjs           # Job discovery + scoring
│   ├── materials.mjs         # Resume/cover letter generation
│   └── submitter.mjs         # Form filling with human gate
├── config/
│   ├── candidate.json        # YOUR profile (gitignored)
│   ├── candidate.example.json # Template for new users
│   ├── roles.json            # Per-role customizations
│   ├── platforms.json        # ATS platform capability matrix
│   └── resume_map.json       # Cluster → resume file mapping
├── lib/
│   ├── template-engine.mjs   # Template merging
│   └── docx-builder.mjs      # ATS-optimized .docx generation
├── templates/
│   └── master_cover_letter.md # Cover letter template
├── routines/
│   ├── daily-scan.md         # Scheduled scan routine
│   ├── generate-materials.md # Materials generation routine
│   └── submit-applications.md # Submission routine (manual)
├── materials/
│   ├── resumes/              # Your PDFs (gitignored)
│   └── cover-letters/        # Generated letters (gitignored)
└── apps-script/
    └── SCORE_FILTER_PATCH.md # Google Apps Script integration
```

## Scoring System

Each role is scored 0-10 across 5 dimensions:

| Dimension | Max Points | Signals |
|-----------|-----------|---------|
| Title match | 3 | Director/VP/Head = 3, Manager/Lead = 2, Other = 1 |
| Skill overlap | 3 | Keyword matches against your skill list |
| Industry fit | 2 | Strong industry = 2, Adjacent = 1, Unrelated = 0 |
| Location | 1 | Preferred city or Remote = 1 |
| Compensation | 1 | Within target range = 1 |

## Safety Rules

- **Never auto-submits** — human approval required for every application
- **Exclusion list** — companies you handle personally or want to avoid
- **No fabrication** — only uses verified metrics from your candidate profile
- **Screenshot audit trail** — captures form state before submission
- **Deduplication** — checks Google Sheet before applying to prevent duplicates

## Claude Code Integration Patterns

This project is built on [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and uses several agentic patterns worth highlighting:

### MCP (Model Context Protocol) Connectors

The pipeline uses multiple MCP servers simultaneously — each one gives Claude direct API access to a service without browser automation:

- **Gmail MCP** — scans LinkedIn/Indeed alert emails, extracts job details, applies processed labels
- **Google Sheets MCP** — reads/writes the job tracker (scores, statuses, Drive links)
- **Google Drive MCP** — uploads tailored resumes and cover letters directly
- **Indeed MCP** — searches jobs and pulls full JD details via API
- **Chrome MCP** — DOM-aware browser automation for ATS form filling (Greenhouse, Lever, etc.)

The key insight: MCP connectors are dramatically faster and more reliable than browser automation. A Gmail search via MCP takes ~1 second; the same search via browser automation takes 15-20 seconds with scrolling, clicking, and screenshot parsing. We use browser automation only when no MCP exists (LinkedIn) or when the ATS requires visual interaction.

### Parallel Agent Architecture (Planned)

The current pipeline runs sequentially: scan → score → generate → submit. The architecture supports parallelism at two levels:

1. **Batch scoring** — score multiple roles simultaneously using Claude Code's Task tool to spawn parallel subagents. Each subagent gets one role + the candidate profile and returns a score independently.

2. **Parallel materials generation** — generate tailored resumes for multiple score-8+ roles concurrently. Each subagent selects the appropriate resume cluster, generates the cover letter, and uploads to Drive.

3. **Multi-platform submission** — submit to multiple Tier 1 platforms (LinkedIn Easy Apply, Indeed) in parallel, with a shared deduplication check against the Google Sheet.

### Scheduled Routines

Claude Code Routines run the scanner on a cron schedule:

```bash
# Scan at 8 AM and 5 PM weekdays
claude routine add job-scanner \
  --schedule "0 8,17 * * 1-5" \
  --prompt "$(cat routines/daily-scan.md)"
```

Each routine execution is a fresh Claude session that reads the current config, scans all sources, scores new roles, and sends an email summary — no persistent process needed.

### Platform-Aware Submission

The submitter agent reads `config/platforms.json` to determine HOW to submit before attempting it. This avoids wasting cycles on sites that will block automation:

```
Tier 1 (MCP/API):     LinkedIn Easy Apply, Indeed, Dice
Tier 2 (Chrome MCP):  Greenhouse, Ashby, Lever
Tier 3 (Manual):      Oracle HCM, Workday, iCIMS
```

This tiering was discovered empirically — Oracle HCM (used by JPMorgan, many Fortune 500) blocks programmatic file uploads entirely, opening a native OS file picker that no browser automation can interact with.

## Built With

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — agent orchestration and MCP integration
- [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) — direct API access to Gmail, Google Sheets, Google Drive, Indeed
- [Claude in Chrome](https://chromewebstore.google.com/detail/claude-in-chrome/) — DOM-aware browser automation for ATS form filling
- [Google Sheets API](https://developers.google.com/sheets/api) — application tracking
- [Google Drive API](https://developers.google.com/drive/api) — materials storage
- [docx](https://www.npmjs.com/package/docx) — ATS-optimized document generation

## Contributing

This project is designed to help job seekers automate the tedious parts of job hunting while keeping humans in control. PRs welcome — especially for:

- New ATS platform support in `config/platforms.json`
- Improved scoring heuristics
- Additional resume cluster strategies
- Integration with more job boards

## License

MIT
