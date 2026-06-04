# Job Apply Daemon

Headless Node + Playwright service that replaces the Cowork-based Chrome MCP submission flow. Designed for unattended bulk apply with no context-window ceiling.

## Why this exists

The Cowork Chrome MCP flow works for 1-3 submissions per session but blows through context on a 60-role sweep. The Easy Apply form lives inside a LinkedIn `<iframe src="/preload/...">` that Chrome MCP `find` and `read_page` cannot see, forcing coordinate-based clicks that are slow and brittle. Playwright's `frameLocator()` traverses the iframe natively.

## Architecture

```
launchd (every 4h)
    ↓
run-once.mjs           — entry: scan → apply → briefing → exit
    ↓
apply-runner.mjs       — orchestrates: relay scan + per-ID applyTo() + Sheet write
    ↓
easy-apply-bot.mjs     — Playwright submitter (login, applyTo)
    ↓                  — uses canned-answers.mjs for open-text Q's
    ├── relay-client.mjs   — wraps Apps Script Gmail Relay endpoint
    └── briefing.mjs       — Gmail API draft (uses lib/gmail-auth.mjs)
```

Outputs:
- `.logs/run-<timestamp>.json` — full summary per cycle
- `.audit/YYYY-MM-DD/<jobId>-{before,after}.png` — submission screenshots
- Sheet rows written for every processed ID (Applied / Materials Ready / Needs Manual Submit / Submit Failed)
- Gmail draft (or sent email with `--send-briefing`) to sav@ensopartners.co

## Setup

### 1. Install dependencies

```bash
cd ~/Documents/Claude/Projects/Job-Application-Agent
npm install
npx playwright install chromium
```

### 2. Capture LinkedIn session (one-time, interactive)

```bash
npm run daemon:login
```

A Chromium window opens. Sign into LinkedIn as `sav.banerjee@gmail.com`. The browser profile is saved to `.secrets/browser-profile/` and reused on every subsequent run. Press Ctrl+C when done.

### 3. Sanity-check Gmail relay

```bash
npm run daemon:relay:scan -- 24
# scans the last 24h of Gmail; prints JSON to stdout
```

### 4. Dry-run the full pipeline

```bash
npm run daemon:run:dry
# scans, walks JDs, but DOES NOT submit or write to Sheet
```

### 5. Live run

```bash
npm run daemon:run -- --hours 24 --max-submissions 5
# scans the last 24h, applies up to 5 Easy Apply roles, drafts briefing
```

Add `--send-briefing` to send the email instead of drafting.

### 6. Install the launchd job (runs every 4h)

```bash
npm run daemon:install
# Loads ~/Library/LaunchAgents/com.sav.job-apply-daemon.plist
# Schedules: 9 AM, 1 PM, 5 PM, 9 PM ET daily
```

Check status:
```bash
npm run daemon:status
tail -f .logs/launchd-stdout.log
```

Uninstall:
```bash
npm run daemon:uninstall
```

## Module reference

### `canned-answers.mjs`
Reads `config/candidate.json` → `easy_apply_answers` and matches question labels by keyword. Public API:
- `loadAnswers()` — returns the canned-answers object
- `matchAnswer(label, answers)` — returns `{key, value}` or `null`
- `numericAnswer(value)` — pulls a leading integer for number fields
- `yesNoAnswer(value)` — maps to "Yes"/"No"/"Prefer not to answer"

CLI: `node daemon/canned-answers.mjs "How many years of AI experience?"`

### `easy-apply-bot.mjs`
Playwright-based submitter.
- `login()` — one-time interactive browser session capture
- `applyTo(jobId, opts)` — full submission lifecycle for one role
  - Returns `{ok, status, job_id, title, company, location, salary, url, submitted_at, unanswered_questions, reason, audit}`
  - Status values: `applied`, `saved_in_progress`, `skipped`, `failed`

Walks the form using `submit > review > next > continue` button precedence. For each form step, scrapes labeled inputs and matches against `canned-answers.mjs`. If any required field has no canned match, the bot saves the application in LinkedIn drafts and returns `saved_in_progress` with the unanswered question labels.

### `relay-client.mjs`
HTTP client for the Apps Script Gmail Relay. Same actions as the Cowork-side relay: `scanGmail`, `cleanConfirmations`, `appendRow`, `updateRow`, `checkDuplicate`, `readRows`.

Note on auth: the relay is deployed "Anyone with Google account" which blocks anonymous daemon fetch. Two paths to fix:
1. Deploy a second copy as "Anyone, even anonymous" and gate via `RELAY_BEARER` (recommended).
2. Run the daemon under a Google session via the OAuth flow in `lib/gmail-auth.mjs`.

The client sends `_auth: process.env.RELAY_BEARER` on every request if set — add a matching `if (e.payload._auth !== SECRET) return 401;` check inside `doPost` in the Apps Script.

### `apply-runner.mjs`
Orchestrates one cycle: scan → for each ID applyTo → dedup → Sheet write → clean_confirmations. Returns a structured summary used by `briefing.mjs`.

### `briefing.mjs`
Formats the summary into a plain-text email and uses `googleapis` (via `lib/gmail-auth.mjs`) to create a draft in Sav's work Gmail. Add `{send: true}` to send instead of draft.

### `run-once.mjs`
Top-level CLI entry. Wires runner → briefing → exit. Writes the summary to `.logs/run-<timestamp>.json`.

### `launchd/com.sav.job-apply-daemon.plist`
macOS launchd schedule. Runs `run-once.mjs` at 9 AM, 1 PM, 5 PM, 9 PM ET. Logs go to `.logs/launchd-{stdout,stderr}.log`.

## Hard filters (in easy-apply-bot.mjs)

```javascript
HARD_FILTERS = {
  excludedCompanies: ['perplexity', 'boi', 'board of innovation'],
  acceptedLocations: /remote|hybrid|new york|nyc/i,
  minSalaryCap: 200_000,
};
```

A role fails any filter → daemon returns `skipped` with a reason, logs to Sheet as Materials Ready, and moves to the next ID.

## What this does NOT do (yet)

- **Cover letter generation** — the Cowork pipeline (`agents/materials.mjs`) still owns this. The daemon submits whatever LinkedIn defaults to.
- **Indeed apply** — Indeed's apply flow is different (Indeed Apply API or partner ATS). When the Indeed MCP is enabled in Cowork, scan results from Indeed should flow through a separate `daemon/indeed-bot.mjs`.
- **Greenhouse / Lever / Workday adapters** — out of scope for Phase 1. Roles needing those portals get "Materials Ready" rows for manual submit.

## Failure modes + recovery

- **LinkedIn login expired** → daemon returns `failed` with "modal did not open"; re-run `npm run daemon:login`.
- **CAPTCHA** → screenshot saved to `.audit/`; daemon halts the cycle, writes alert to briefing.
- **Open-text question with no canned answer** → application saved in LinkedIn drafts; question label included in briefing under "SAVED IN-PROGRESS". Add the answer to `config/candidate.json` → `easy_apply_answers` and the next run will catch it.
- **Apps Script relay timeout** → daemon retries 2x with exponential backoff, then logs error to briefing.
