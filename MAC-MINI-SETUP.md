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
> 5b. **CREATE THE SINGLE-SUBMITTER MARKER — ONLY on the Mac Mini:** `touch .secrets/submitter.allow`.
>    This file (gitignored, never in git) is what AUTHORIZES this machine to LIVE-submit. The daemon
>    fail-closes: any host WITHOUT it is forced to dry-run no matter what flags it's given. This is the
>    cross-machine double-submit guarantee — exactly ONE machine holds the marker, so exactly one
>    machine ever writes an application. **Never create this file on the MacBook Pro.** Confirm it's
>    the ONLY machine with it. (A local O_EXCL lockfile `.secrets/submit-ready.lock` additionally
>    prevents two runs overlapping on THIS machine — it's automatic, nothing to set up.)
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
- **MacBook Pro**: its `job-pipeline-daily` task is **already disabled** (2026-06-16), and the
  single-submitter guard now FORCES it to dry-run even if invoked — so it can never live-submit.

## No-double-submit guarantee (hardened 2026-06-16, audit + adversarial review)
Belt-and-suspenders, ordered from the real guarantee outward:
1. **Single-submitter marker** (`.secrets/submitter.allow`, Mac Mini only) → exactly ONE machine can
   live-submit. Fail-closed: no marker = dry-run. This is THE cross-machine guarantee.
2. **Local O_EXCL lockfile** (`.secrets/submit-ready.lock`) → one submit process per machine; a second
   concurrent run exits cleanly. Stale locks (dead PID / >30 min) auto-reclaimed.
3. **Live re-check** before every submit → re-reads the row's current status; skips if another run
   already took it. **Broadened dedup cache** (any Applied Date / terminal status, both keys) blocks
   re-applying. **Hard-fail** if the dedup cache can't load on a live run (never submits blind).
4. **"Could not confirm" → "Needs Review"** → an ambiguous submit is quarantined, NEVER auto-retried
   (the one vector that could double-submit a posting that actually went through). A human verifies it.
- Notion stays the single shared source of truth. Note: a true cross-machine *mutex* is impossible in
  Notion (no compare-and-set), which is exactly why layer 1 (one machine) is the guarantee, not the lock.
