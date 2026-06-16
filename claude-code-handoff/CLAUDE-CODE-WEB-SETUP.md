# Run the Job Agent on Claude Code on the web (cloud, laptop-off)

This keeps the scan running on Anthropic's cloud on a schedule even when your MacBook is off.
Grounded in the official docs:
- Claude Code on the web: https://code.claude.com/docs/en/claude-code-on-the-web
- Routines (cloud schedules): https://code.claude.com/docs/en/routines
- Routines manager: https://claude.ai/code/routines

A **Routine** = a saved prompt + a repo + connectors + a schedule, run on Anthropic-managed cloud
infrastructure. It keeps working when your laptop is closed.

---

## ⚠️ Read this first — two things make or break the cloud run

**1. The cloud clones your GitHub repo — but your config + resumes are gitignored.**
`.gitignore` excludes `config/candidate.json`, `materials/resumes/*.pdf`, and `.claude/` because
`github.com/nycsav/job-application-agent` is **public**. A cloud run off that public repo would have
**no profile and no resumes** and would halt at pre-flight.

➡️ **Fix: point the Routine at a PRIVATE repo that contains the real files.** Two ways:
   - **Flip the existing repo to Private** (GitHub → repo → Settings → Danger Zone → Change
     visibility → Private), then commit the profile + resumes (see checklist below). Simplest.
   - **Or keep the public repo as your open-source showcase and push a separate private repo**
     (e.g. `job-application-agent-private`) with the real files. Cleanest separation.

   Either way, the private repo must contain (push these from your Mac):
   ```
   config/candidate.json
   materials/resumes/Sav_Banerjee_Resume_2026_v3.pdf
   materials/resumes/Sav_Banerjee_Resume_2026_MD_ManagedServices.pdf
   materials/resumes/Sav_Banerjee_Resume_2026_PMM_v2.pdf
   materials/resumes/Sav_Banerjee_Resume_ForwardDeployed_2026.pdf
   agents/   templates/   package.json   CLAUDE.md
   ```
   Still keep OUT of git, even in the private repo: `config/gmail-token.json`,
   `config/gmail-credentials.json`, `config/pipeline.json`, anything under `.secrets/`. Gmail is
   handled by the **Gmail connector** in the cloud, not the local token file.

**2. Cloud routines run with NO approval prompts. Connectors can write without asking.**
That's why the routine prompt (`routine-prompt.md`) is **scan-and-stage-only** — it never submits,
never runs the Easy-Apply daemon. Keep submission as a separate manual step you do from your desktop
with the human gate. Do not add `--submit` or the daemon to the cloud routine.

---

## Step-by-step (web UI)

**1. Connect GitHub.** Go to https://claude.ai/code → connect your GitHub account when prompted
(or run `/web-setup` in the Claude Code CLI). Grant access to the private repo from Step 1.

**2. Confirm your connectors are on your claude.ai account.** Routines use the connectors on your
account (the ones you authorized in the Claude desktop app), **not** anything added via
`claude mcp add`. Check **Settings → Connectors** at https://claude.ai/customize/connectors —
you should see **Notion**, **Gmail** (Enso inbox), and the **job-search / Dice** connector. If one is
missing, add it there first.

**3. Create the routine.** Go to https://claude.ai/code/routines → **New routine**.
   - **Name:** `Job Scan — Stage Materials Ready`
   - **Instructions:** paste the entire contents of `claude-code-handoff/routine-prompt.md`.
   - **Model:** Opus (or Sonnet to save usage).

**4. Select repositories.** Add your **private** job-application-agent repo.

**5. Select environment.** **Default** (Trusted network) is fine — MCP connector traffic routes
through Anthropic's servers, so Notion / Gmail / Dice work without any network change. Only edit the
environment → **Network access → Custom** (add domains) **or Full** if you want the agent to fetch
live JD pages from `dice.com` / company career sites or use web search. Otherwise it relies on the
Dice connector's built-in summaries, which is enough for scoring.

**6. Connectors tab (bottom of the form).** All your connectors are included by default —
**remove everything except Notion, Gmail, and job-search/Dice.** This limits what the unattended run
can touch.

**7. Permissions tab.** Leave branch pushes **restricted** (default `claude/` only). The routine
doesn't need to push code.

**8. Add the schedule trigger(s).** Under **Select a trigger → Schedule**, pick **Weekdays** and set
**11:00 AM** (your local ET — times auto-convert). Click **Add another trigger → Schedule → Weekdays
→ 12:00 PM** for the second daily run. (For a custom cron instead, create one schedule, then run
`/schedule update` in the CLI. Minimum interval is 1 hour.)

**9. Create, then test.** Click **Create**, open the routine, and click **Run now**. Open the run
session and read the transcript.

---

## How to verify a run worked
- A **green** status only means the session started and exited — **not** that the task succeeded.
  Open the run and read the transcript + final briefing message.
- Check **Notion** (Career Command Center) for new *Materials Ready* pages with a routed resume +
  cover-letter path. That's the real proof.
- On the first run especially, confirm the connectors authenticated (no "missing connector tool" or
  `403 host_not_allowed` errors in the transcript).

## Known limits / caveats (research preview)
- **JobRight / personal Gmail** (`sav.banerjee@gmail.com`) uses a local token scanner that won't run
  in the cloud. Either connect that Gmail account as a second connector, or accept that source is
  skipped in cloud runs — Ladders (Enso inbox) still works via the Gmail connector.
- **Daily routine run cap** applies per account; two weekday triggers = 2 runs/day, well within it.
- **Connectors must be account-level** — anything you only added with local `claude mcp add` won't
  appear. Add it at Settings → Connectors or via a committed `.mcp.json`.
- Routines are a **research preview**; behavior and limits may change. Verify the first Run now before
  trusting the schedule.

## TL;DR
1. Put profile + resumes in a **private** repo (public repo gitignores them).
2. Connect GitHub + confirm Notion/Gmail/Dice connectors on your account.
3. claude.ai/code/routines → New routine → paste `routine-prompt.md` → select the private repo →
   Default env → keep only Notion/Gmail/Dice connectors → Weekdays 11 AM + 12 PM → Create → Run now.
4. It scans + stages to Notion in the cloud, laptop off. **Submission stays manual** with your gate.
