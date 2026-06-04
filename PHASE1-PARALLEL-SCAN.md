# Phase 1 — Parallel Scan (lead + source specialists) · 2026-06-03

Continuation of `HANDOFF-jobagent-frontend-2026-06-02.md` §3/§5/§8. Builds the
parallel-agent scan and proves it live, on the Cowork Agent tool (no per-session
fee), structured for one-step promotion to hosted **Managed Agents** (Phase 2).

## What shipped
- **`agents/parallel-scanner.mjs`** — the LEAD orchestrator.
  - `SOURCE_SPECIALISTS`: one pluggable async specialist per source (LinkedIn,
    Ladders, JobRight; Indeed/Substack slot in with no orchestrator change).
  - `fanOut()` runs all specialists with `Promise.allSettled` → one failing
    source can't stall the run (this morning a LinkedIn keyword *did* error; the
    pattern survives it).
  - Fans back into the **real** `scoreRole()` + `roleQualificationGate()` from
    `scanner.mjs` — no scoring/safety logic was re-implemented or forked.
  - Hard filters (salary ≥ $180K, NYC/remote, exclude list) run **before**
    scoring, per `feedback_hard_filters`. Company-level "never twice" dedupe.
  - CLI smoke test runs off `reports/parallel-scan-fixture.json` with no creds.

## Proof run (live, this session)
A lead delegated **2 source-specialist sub-agents in parallel** (managed
sub-agents via the Agent tool): a LinkedIn specialist + a Ladders specialist.
Both returned normalized role lists concurrently; the lead fanned 13 roles into
the scorer:

| Bucket | Result |
|---|---|
| **8+ auto-materials** | **Acxiom — Senior Director, Data & AI Advisory** (Remote, $150–200K) — **score 9, NET-NEW** (Ladders source; missed by the morning keyword scan) |
| 7 high-profile | EY — AI Solutions Manager, Consulting ($125–230K) |
| 5–6 tracked | 2× Capital One (already-in-tracker variants), eMoney SVP |
| skipped | company-already-in-tracker (JPM, ViacomCBS, Capital One), non-NYC/remote (WOONGJIN, Hackensack) |

**Bug caught by the live run:** the salary parser read "$346K" as $346, wrongly
filtering high-paying Ladders roles. Fixed (`parseSalaryCeiling` now handles
K/M suffixes + hourly). Re-run promoted Acxiom from "skipped" to the 8+ bucket.

## Honest caveats
- Specialist `summary` text in the proof was the digest snippet, not the full
  JD — so the score-9 reflects keyword density, not a fetched JD. **Do not stage
  Acxiom to Notion off this; fetch the live JD first, then score + stage.**
- Company-name normalization needed: "Capital One" vs "Capital One Financial
  Corporation" dodge the company-level block. Add an alias map before Phase 2.

## Phase 2 promotion — Managed Agents Multi-Agent Orchestration
The transport is the only thing that changes. Concretely:
1. Register each `SOURCE_SPECIALISTS` entry as a hosted sub-agent (own
   model/prompt/scoped tools) under one lead agent on a shared filesystem.
2. The lead's delegation maps 1:1 onto `fanOut()` — `s.run(ctx)` becomes a
   `delegate()` call; `Promise.allSettled` becomes the orchestration's parallel
   join. `scoreRole()` + the gate stay byte-for-byte identical.
3. Keep the human-gated submit + the CopilotKit copilot on the **Agent SDK** in
   Vercel (token-only); only the daily background scan pays the
   ~$0.08/session-hour Managed-Agents fee. Confirm the live rate before cutover.

**Reminder (from yesterday's decision):** Managed Agents buys operational
reliability — daily hands-off runs, retries, session persistence, Dreaming/
Outcomes learning. It does **not** change application quality, which is
runtime-agnostic. Prove correctness here first; promote when the daily run is
boringly reliable.

## Next moves
1. Wire the LinkedIn/Ladders/JobRight specialists to live `ctx` fetchers (inject
   the job MCP + Gmail clients) so `runParallelScan(ctx)` runs unattended.
2. Add the company alias map; add Indeed + Substack specialists.
3. Fetch the **Acxiom** + **EY** JDs, re-score on real text, stage if ≥8.
4. When the daily run is reliable for a week, do the Phase-2 cutover above.
