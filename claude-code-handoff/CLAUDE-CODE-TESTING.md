# Moving the Job Agent to Claude Code — testing handoff

Goal: run the same scan → score → stage-to-Notion pipeline interactively in **Claude Code**,
so you can test it outside Cowork. The repo already contains the code (`agents/`, `orchestrator.mjs`,
`daemon/`, `lib/`). This folder adds the three missing pieces: an **MCP config**, a **`/job-scan`
slash command** (the prompt), and the **settings** below.

The honest model is unchanged (see `HONEST-AUTOMATION-ASSESSMENT-2026-06-03.md`): everything is
automated **up to the submit button**. Nothing auto-submits to LinkedIn or a login/CAPTCHA ATS.
"Testing" here means: confirm the scan runs, roles get scored + gated correctly, and strong roles
land in Notion as *Materials Ready*.

---

## One-time setup (copy-paste, in order)

Run these in Terminal. Each block is one command.

**1. Open the repo in Claude Code**
```bash
cd ~/Documents/Claude/Projects/Job-Application-Agent
claude
```

**2. Install dependencies** (inside the repo, in a normal terminal tab)
```bash
npm install
```

**3. Put the three handoff files in place**
```bash
cp claude-code-handoff/mcp.json .mcp.json
mkdir -p .claude/commands && cp claude-code-handoff/job-scan.md .claude/commands/job-scan.md
```
(Leave the existing `.claude/settings.json` alone for now — replace it in step 5 only if you want
the submission-gate hook.)

**4. Add the connectors (MCP servers)**
The agent needs three connectors — the **same ones** you already authorized in the Claude desktop
app. Two ways to wire them:

- *Easiest:* open `.mcp.json` (now at the repo root) and paste the **Gmail** and **Job-search**
  connector URLs into the two `<FILL_IN>` slots. Get each URL from the Claude desktop app →
  **Settings → Connectors →** open the connector → **Copy link**. Notion's URL is already filled in.
- *Or via CLI:*
  ```bash
  claude mcp add --transport http notion https://mcp.notion.com/mcp
  claude mcp add --transport http gmail <GMAIL_CONNECTOR_URL>
  claude mcp add --transport http dice-jobs <JOB_SEARCH_CONNECTOR_URL>
  ```

On the first `/job-scan` run, Claude Code opens a browser tab to log in to each connector (OAuth).
Approve all three once.

**5. (Recommended) Enable the submission-safety hook** — replace `.claude/settings.json` with:
```json
{
  "enableAllProjectMcpServers": true,
  "permissions": {
    "allow": [
      "Read(*)", "Write(output/**)", "Write(.logs/**)", "Edit(*)",
      "Bash(node*)", "Bash(npm run*)", "Bash(pandoc*)",
      "WebSearch", "WebFetch",
      "mcp__notion__*", "mcp__gmail__*", "mcp__dice-jobs__*"
    ],
    "deny": []
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command",
            "command": "echo '⚠️  SUBMISSION GATE: review any daemon:apply / submit step before approving.'" }
        ]
      }
    ]
  }
}
```

---

## How to test

Inside Claude Code (the `claude` prompt), type:

| Command | What it does |
|---|---|
| `/job-scan` | Full run: scan last 7 days → score → stage Materials Ready to Notion → write a briefing to `output/briefings/`. Stages nothing to submit. |
| `/job-scan --incremental` | Same, but Dice search uses `posted_date: ONE` (last 24h) — use this for repeat test runs so you don't re-scan the same week. |
| `/job-scan --dry-run` | Scan + score + print what *would* be staged, **without writing to Notion**. Best first test. |
| `/job-scan --submit` | Adds the gated Easy-Apply daemon step (cap 5) **after** you approve. Leave this off while testing. |

Recommended first test: **`/job-scan --dry-run`**. You should see pre-flight pass, a list of scored
roles with gate decisions, and a "would stage / would hold" summary — with no Notion writes.

You can also test pieces directly from a terminal:
```bash
npm run scan            # scanner.mjs only
npm run daemon:run:dry  # daemon, dry-run (no submits)
node -e "import('./agents/scanner.mjs').then(m=>console.log(Object.keys(m)))"   # confirm scoreRole + roleQualificationGate are exported
```

---

## What "passing" looks like
1. Pre-flight: 4 resume PDFs found >50 KB; Notion search returns the Career Command Center.
2. Scan returns roles from Dice + Ladders without one source stalling the others.
3. Gate correctly **skips** IC engineer / CS-degree-required roles and **passes** advisory/strategy
   leadership roles.
4. Score-8+ roles appear in Notion as *Materials Ready* with a routed resume + a <400-word cover
   letter path; score 5–7 as *New*; held roles as *Archived* with a reason.
5. A briefing file lands in `output/briefings/`.

## Notes / gotchas
- **Connector names matter.** The `/job-scan` prompt expects tool prefixes `mcp__notion__`,
  `mcp__gmail__`, `mcp__dice-jobs__`. If you name a server differently in `.mcp.json`, update the
  `allowed-tools` line at the top of `.claude/commands/job-scan.md` to match.
- **Cowork-only tools aren't here.** Claude Code has no `create_artifact` and no Cowork task list, so
  the briefing is written as a file instead of a live artifact. Everything else is identical.
- **Notion IDs are pinned** in the prompt (DB `8ce2a0e3-…`, data source `931eceb1-…`) — no change needed.
- **Never commit secrets.** `.mcp.json` holds only connector URLs (OAuth handles auth), but keep
  `config/gmail-token.json` and anything under `.secrets/` out of git (already in `.gitignore`).
