# Cleanup & Consolidation Work Order — execute in a fresh session

Read this + `HANDOFF-2026-06-19.md` first. Goal: collapse the sprawl into ONE clean
pipeline + Notion front end + a real submit layer. Propose a delete/keep list for
Sav's approval BEFORE deleting anything.

## Why
- Two codebases write to one Notion DB (this repo's scans + `notion-career-agent` Worker) → duplicates.
- Dead/risky paths: Google Sheet archive, the LinkedIn Easy-Apply Playwright daemon (ToS/ban risk).
- Doc sprawl: many HANDOFF-* / ARCHITECTURE-* / ASSESSMENT-* files.
- The "agent auto-applies" goal was a mirage (no apply API, ATS bot-block). Submit moves to Simplify/Apply4Me.

## Target end-state
- **Notion Career Command Center = single source of truth (front end).**
- **One writer**, using the shared key `lib/dedup.mjs`. Recommended split:
  - `job-application-agent` = the find → score → dedup → stage engine (run via Claude Code).
  - `notion-career-agent` Worker = optional scheduled trigger only; adopt the same dedup key (patch ready: `patches/notion-career-agent-dedup.patch`). Never both writing un-keyed.
- **Submit layer = Simplify Copilot (assisted) + Ladders Apply4Me (human).** Retire the Playwright daemon.

## Audit (read both repos + the live DB)
- `job-application-agent`: `agents/`, `lib/`, `daemon/`, `config/`, all docs.
- `notion-career-agent`: `src/index.ts`, `workers.json`.
- Notion DB: **enumerate ALL rows** — this session only cleared the confirmed dup clusters.

## Propose to RETIRE (confirm before deleting)
- `daemon/` (apply-runner, easy-apply-bot, relay-client) — LinkedIn auto-apply = ToS/ban risk, superseded.
- `lib/sheet-writer.mjs` + Google Sheet / Drive legacy refs.
- Substack shadow mode in `orchestrator.mjs` — promote to Phase 2 or remove.
- Collapse HANDOFF-* / ARCHITECTURE-* / ASSESSMENT-* into ONE current README + ONE handoff.
- Reconcile the two divergent Notion schemas (Job Title/Fit Score vs Job ID/Role/Match Score) into one.

## KEEP / consolidate
- `lib/dedup.mjs`, `lib/notion-queue.mjs`, `agents/notion-submitter.mjs`, `lib/resume-picker.mjs`.
- `config/candidate.json` + `config/resume_map.json` + `materials/` (gitignored — keep local).

## Then
- Full dedup pass on remaining rows using the Company+Title / URL key.
- Wire the Notion → Simplify/Apply4Me runbook as the operating loop.

## First action in the fresh session
Inventory both repos, present a delete/keep list for approval, execute, then run one clean daily-discovery pass that stages a deduped shortlist.
