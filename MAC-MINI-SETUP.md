# Mac Mini Handoff — make it the always-on submission runner

Goal: the Mac Mini at home runs the job-application **submit** pipeline independently, so the
MacBook Pro can leave the house. (Scanning already runs in the cloud routine — no Mac Mini step
for that.) Code transfers via git; PII/secrets transfer manually (they're gitignored on purpose).

Branch with today's work: **`mac-mini-handoff`** on `origin` (github.com/nycsav/job-application-agent).

---

## PART A — Do these on the MacBook Pro before you leave (2 min)

1. **AirDrop these 6 gitignored files to the Mac Mini** (they are NOT in git — PII/secrets):
   - `config/candidate.json`
   - `materials/resumes/Sav_Banerjee_Resume_2026_v3.pdf`
   - `materials/resumes/Sav_Banerjee_Resume_2026_MD_ManagedServices.pdf`
   - `materials/resumes/Sav_Banerjee_Resume_2026_PMM_v2.pdf`
   - `materials/resumes/Sav_Banerjee_Resume_ForwardDeployed_2026.pdf`
   - `.secrets/notion-token.txt`
   - `.secrets/dice-credentials.txt`  *(the Dice email + password live here — keep it out of git)*
   *(Skip the 602 MB `.secrets/browser-profile` — do NOT transfer it. The Mac Mini re-logs in fresh,
   which is cleaner and avoids a broken cross-machine browser profile.)*

2. **Keep the Mac Mini awake:** System Settings → Lock Screen / Battery → set "turn display off"
   is fine, but **Energy: prevent automatic sleeping** (or `caffeinate`), or scheduled runs won't fire.

3. Make sure **Claude Code is installed on the Mac Mini** and signed into the same account.

---

## PART B — Paste this to a NEW Claude Code session ON the Mac Mini

> Set up this machine as the always-on job-application submitter. Steps:
> 1. Clone + checkout the working branch:
>    `git clone https://github.com/nycsav/job-application-agent.git ~/Documents/Claude/Projects/Job-Application-Agent && cd $_ && git checkout mac-mini-handoff`
> 2. Install deps: `npm install` then `npx playwright install chromium`.
> 3. Place the 6 AirDropped files into the cloned repo at the SAME paths
>    (`config/candidate.json`, the four `materials/resumes/*.pdf`, `.secrets/notion-token.txt`).
>    Create `.secrets/` if missing. Verify: `node -e "JSON.parse(require('fs').readFileSync('config/candidate.json'))"`
>    and that each resume is >50 KB.
> 4. Log the persistent browser profile into the job sites (one-time, headed):
>    - LinkedIn: `node daemon/easy-apply-bot.mjs --login` → sign in → Ctrl+C.
>    - Dice: `node daemon/capture-login.mjs dice` → sign in with the email + password from
>      `.secrets/dice-credentials.txt` → Ctrl+C.
> 5. Verify the pipeline end-to-end WITHOUT submitting: `node daemon/submit-ready.mjs --dry-run`.
>    Expect it to query Notion (queue + dedup) and stage cover letters with no errors. The daemon
>    self-heals a missing browser / stale profile lock / transient Notion blip on startup.
> 6. Recreate the scheduled task on THIS machine (so it runs here): create a scheduled task named
>    `job-pipeline-daily`, cron `0 9,13 * * 1-5`, model `claude-opus-4-8`, using the prompt body in
>    `~/.claude/scheduled-tasks/job-pipeline-daily/SKILL.md` from the MacBook (AirDrop that file too if
>    you want it verbatim) — it's the submit-focused pipeline: Ladders intake → dry-run → live submit
>    (max 7) → file emails into "Job Applications 2026" → briefing with the Notion link.
> 7. Approve the live-submit Bash permission ONCE here (Run now → approve) so future scheduled runs
>    submit autonomously without prompting.
>
> Hard rules carried over: never submit to Perplexity / BOI / Sia; salary floor $180K FTE / $85hr;
> batch cap 7/run; stop at CAPTCHAs/login walls; Notion is the source of truth.

---

## What stays where (so nothing's double-run)
- **Cloud scan routine** (claude.ai/code/routines): unchanged, runs in the cloud — keep it on.
- **Submit pipeline + scheduled task**: now on the **Mac Mini** (after this setup).
- **MacBook Pro**: once the Mac Mini is verified submitting, **disable/delete the `job-pipeline-daily`
  task on the MacBook** so the two don't both submit (dedup would catch it, but cleaner to run one).
- Notion remains the single shared source of truth — both machines read/write the same DB, and the
  two-key dedup (company+title + apply-URL) prevents duplicate applications across machines.
