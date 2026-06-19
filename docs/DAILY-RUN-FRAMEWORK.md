# Daily Run Framework — Two Engines, One Gate

How the job application agent actually runs day-to-day. See `job-agent-framework.html`
for the visual.

## The split (and why)

The pipeline runs across **two environments** because the work needs two different
capabilities that don't live in the same place:

| Engine | Where it runs | What it does | Why here |
|---|---|---|---|
| **1 — Collect & Pick** | Claude (cloud session) | Scan inbox + boards → score → dedup → stage to Notion | Has the connectors (Gmail, Indeed, Dice, Notion). Read-only on email. **No browser.** |
| **GATE** | You | Approve the queue in Notion (one screen) | The one rule the whole system is built on: nothing submits without you. |
| **2 — Apply & File** | Claude Code + Playwright MCP on your Mac (`npm run submit:notion`) | Read the Approved queue → fill the ATS from profile → **stop for you to click Submit** → file back | The browser + your logged-in sessions (LinkedIn/Ladders/ATS) live here. The old unattended Easy-Apply daemon was retired (ToS/ban risk). |

### Why not "apply from the cloud session"
The cloud session can read email and write Notion, but it has **no web browser**.
Submitting a job application means filling a form on the employer's site
(Greenhouse / Ashby / Lever / Workday / Ladders Apply4Me) — that requires a
logged-in browser, which only exists on your Mac.

### Why not Notion Agents / Workers
Notion Agents automate work **inside Notion**. They can't drive an external
employer's application form either. The apply step still belongs to the Mac runner.

## The 6 steps (twice daily — ~8 AM & 5 PM weekdays)

1. **Scan** — Enso Gmail (Ladders, LinkedIn alerts), Indeed, Dice.
2. **Score & dedup** — 0–10 vs `config/candidate.json`; skip anything already in Notion.
3. **Stage** — write "New" rows to the Career Command Center with fit score, assigned
   resume variant, and apply link.
4. **GATE** — you review and approve in Notion (move to `Approved`).
5. **Apply** — `npm run submit:notion` (Claude Code + Playwright MCP) on your Mac reads the
   Approved queue, fills each ATS form, and **stops before Submit** for your click.
6. **File** — email → `AI-Applied` Gmail label · Notion → `Applied` (+ Applied Date) · calendar logged.

## Integrity rules (non-negotiable)
- An email is moved to **AI-Applied** and a Notion row set to **Applied** **only after a real
  submission** — never speculatively. A false "applied" record makes you skip a live role.
- Metrics and client names come verbatim from `config/candidate.json` — never fabricated.
- `config/candidate.json` is gitignored — PII never enters the repo.

## To run Engine 2 (on your Mac)
```bash
# one-time: restore config/candidate.json + config/gmail-credentials.json + token locally
npm install
npm run queue:notion       # show the Approved queue (read-only)
npm run submit:notion      # Claude Code + Playwright fills each form; STOPS before Submit for your click
```
