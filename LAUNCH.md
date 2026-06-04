# Job Application Agent — Claude Code Launch Script

## Pre-Flight: What Cowork Already Fixed
- ✅ submitter.mjs syntax error (line 226 corrupt char)
- ✅ Google Drive folder ID reconciled → all files now point to `1OOsMcQMegAUg5Ezy47rqiPh7ZAnBZHto`
- ⏳ Gmail label "JobAgent/Processed" — needs Claude Code (Cowork connector lacks write perms)

---

## PHASE 1: Environment Setup (Claude Code Terminal)

### 1A. Open Project
```bash
cd ~/Projects/Job-Application-Agent
claude
```

### 1B. Install Composio for Personal Gmail
```bash
# Install Composio CLI
npm install -g composio-core

# Login (free tier — opens browser once)
composio login

# Add personal Gmail (opens Google OAuth — one-time browser consent)
composio add gmail

# Register as MCP server in Claude Code
claude mcp add gmail-personal -- composio serve -t gmail
```

After this, Claude Code uses ONE email for the entire job agent:
- gmail-personal → sav.banerjee@gmail.com (scanning, briefings, everything)
- The native Gmail MCP (sav@ensopartners.co) is NOT used by this agent

### 1C. Create Gmail Label for Deduplication
In Claude Code REPL:
```
Create a Gmail label called "JobAgent/Processed" in sav.banerjee@gmail.com using the gmail-personal MCP. Use blue background (#b6cff5) and dark blue text (#0d3472).
```

### 1D. Install Playwright MCP (for Submitter Agent)
```bash
claude mcp add playwright -- npx @anthropic/playwright-mcp@latest
```

### 1E. Verify All MCP Servers
```bash
claude mcp list
```
Expected output should show: gmail-personal (composio), google-drive, google-sheets, playwright

---

## PHASE 2: Google Sheet Tracker Updates

In Claude Code REPL, paste this prompt:

```
Open Google Sheet "Sav Job Tracker 2026" (ID: 1Wd0x_0fEAyScgMKB9neneuMIo3Sgln-CMytWMF8m6eI).

1. ADD COLUMNS to "Jobs" tab — after the last existing column, add:
   Source | Platform | Status | Applied Date | Run ID | Resume Version | Resume Link | Cover Letter Link | Response | Notes

2. ADD COLUMNS to "High Profile" tab — same columns as above.

3. CREATE NEW TAB called "Run Log" with these headers:
   Run ID | Run Time | Schedule Type | Jobs Found | Jobs New | Materials Generated | Score 9-10 | Score 7-8 | Score 5-6 | Sources Used | Notes

4. Verify by reading the first row of each tab back to me.
```

---

## PHASE 3: First Test Run

### 3A. Manual Scan (Read-Only Test)
Paste this into Claude Code:

```
Read the routine at Job-Application-Agent/routines/daily-scan.md and execute Steps 1-5 ONLY (scan + score + log to sheet). Do NOT generate materials yet. 

Use gmail-personal MCP to scan sav.banerjee@gmail.com for job alerts.
Do NOT use the native Gmail MCP — all email ops go through gmail-personal.

Report what you find: how many emails scanned, how many jobs extracted, scores for each.
```

### 3B. Materials Generation (If Scan Succeeds)
```
Now execute Step 6 from daily-scan.md — generate materials for any score 8+ roles found in the scan. Upload to Google Drive folder 1OOsMcQMegAUg5Ezy47rqiPh7ZAnBZHto. Update the tracker.
```

### 3C. Briefing Email
```
Execute Step 7 — send the daily briefing email to sav.banerjee@gmail.com via gmail-personal MCP with results from this run.
```

---

## PHASE 4: Set Up Recurring Routine

Once the manual run succeeds:

```bash
claude routine add job-scanner \
  --schedule "0 8,17 * * 1-5" \
  --prompt "$(cat routines/daily-scan.md)"
```

This runs the full scan at 8 AM and 5 PM on weekdays.

---

## Key IDs Reference
- Google Sheet: `1Wd0x_0fEAyScgMKB9neneuMIo3Sgln-CMytWMF8m6eI`
- Google Drive folder: `1OOsMcQMegAUg5Ezy47rqiPh7ZAnBZHto`
- Gmail: sav.banerjee@gmail.com (via gmail-personal MCP — ALL email ops)

## Exclusions (enforced in scanner.mjs + routine prompt)
- NEVER: Perplexity, BOI / Board of Innovation

## Safety Rules
- NEVER auto-submit applications without human approval
- NEVER fabricate metrics or client names
- Max 5 materials per run
- Gore → always "Global Materials Manufacturer"
