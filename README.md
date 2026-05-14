# Job Application Agent

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

## Built With

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — agent orchestration
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
