# Substack Source — Implementation Plan

**Owner:** Sav Banerjee
**Created:** 2026-05-20
**Status:** Scaffold complete, integration pending

## Why

The a16z Build newsletter (May 12) listed 17+ founding-team roles at funded startups (Kalshi, Phylo, Pearl Health, Mariana Minerals, Cresta, UnitedMasters, etc.) — exactly the role profile the pipeline is tuned for, and these don't surface through LinkedIn alerts or the 8 tracked career pages. Adding curated VC/operator newsletters as **Source 3** captures this dealflow with zero new credentials.

## Connector decision

**There is no dedicated Substack MCP in the registry.** Searched both `mcp-registry` and the plugin marketplace — nothing fits. The clean integration is **RSS** — every Substack publication exposes `/feed` as well-formed RSS 2.0 with full HTML content embedded. No auth, no rate limits to worry about at this scale, no API quota.

## Architecture (drops into existing pipeline)

```
Source 1: Gmail alerts ──┐
Source 2: Career pages ──┼──► scoreRole() ──► Google Sheet ──► Materials Agent (8+)
Source 3: Substack RSS ──┘     [reused]        [Jobs / High Profile tabs]
```

No new sheet, no new scoring, no new submitter. The Substack scanner produces rows in the same shape as the existing two sources and joins the same downstream flow.

## Components delivered

| File | Purpose |
|------|---------|
| `config/substack-sources.json` | 6 curated feeds + extraction hints + per-feed score floors |
| `agents/substack-scanner.mjs` | RSS fetch → post filter → listing extraction → reuse `scoreRole()` → ranked output |

The scanner imports `scoreRole`, `EXCLUDE_COMPANIES`, and `MINIMUM_SHEET_SCORE` directly from `agents/scanner.mjs` — same rubric guarantees identical scoring behavior across sources.

## Scoring (unchanged)

Every extracted role runs through the existing 0-10 rubric:

| Signal | Max | Source |
|---|---|---|
| Title match (Director / VP / Head / Principal) | 3 | role.title |
| Skill overlap (AI strategy, agentic, Claude, MCP, enterprise consulting, …) | 3 | post body |
| Industry fit (AI/ML, tech, consulting) | 2 | post body |
| Location (NYC / Remote / Hybrid) | 1 | extracted location |
| Compensation signal (proxy via seniority) | 1 | role.title |

Thresholds: `<5` skip · `5–6` Jobs tab · `7+` High Profile · `8+` auto-materials.

Perplexity + BOI exclusion enforced.

## Smoke test results (30-day window over the 6 feeds)

- **3 posts** matched hiring trigger phrases
- **60 listings** extracted
- **4 roles** cleared score ≥ 5 (e.g. Zipline Director of Federal Affairs scored 6)
- 1 feed needed URL fix (Every.to)

This validates that extraction + scoring + dedup all work end-to-end before any sheet integration.

## Curated feed set (Tier 1 / Tier 2)

| Publication | Tier | Min score | Rationale |
|---|---|---|---|
| a16z Build | primary | 5 | Source of the original recommendation; founding-team focus |
| Lenny's Newsletter | primary | 5 | Heavy PM/growth circulation |
| The Generalist | primary | 5 | Mario Gabriele — frequent hiring callouts |
| Not Boring | secondary | 6 | Strategic essays, occasional portfolio lists |
| Stratechery | secondary | 7 | Strategic moves → hiring waves |
| Every | secondary | 6 | Bundle of newsletters (AI/founder roles) |

Per-feed `min_score_to_track` lets stricter floors apply to noisier feeds without diluting the main Jobs tab.

## Rollout — 3 phases

**Phase 1 — Shadow run (this week)**
Wire `scanSubstack()` into `orchestrator.mjs` but write results to a `substack-discoveries.log` file, not the sheet. Review the first 3 daily runs to spot extraction misfires (wrong company name, wrong title) before letting it touch the tracker.

**Phase 2 — Sheet integration (after 3 clean runs)**
Push scored rows into the existing Jobs / High Profile tabs with `Source = "Substack"` in the Source column. Watch the dedup gate — Substack often re-lists the same role the career-page scanner has already found.

**Phase 3 — Auto-materials enablement (after 1 week stable)**
Allow `score 8+` Substack roles to trigger the Materials Agent like any other source. By that point, extraction quality is known good and `EXCLUDE_COMPANIES` covers any failure modes seen during shadow run.

## Cron / scheduling

Reuse the existing `0 8,17 * * 1-5` routine (8 AM and 5 PM weekdays). The Substack scan adds ~5 seconds — well within the run budget. No separate schedule needed.

## Known limitations (acceptable for v1)

1. **Heuristic extraction** — regex-based parsing of `<li>` blocks. Will miss roles formatted as prose paragraphs or as embedded job-board widgets. Acceptable: the structured-list format is the dominant pattern in these newsletters. If hit rate disappoints after Phase 1, swap the parser for a Claude Haiku call via `window.cowork.askClaude()` style extraction.
2. **Company-name guessing** — sometimes grabs a founder's name instead of the company. Mitigated v1.1 by preferring URL-derived names (`jobs.ashbyhq.com/<company>`). Still imperfect.
3. **No paywall support** — RSS only includes preview text for paywalled posts. a16z Build, Lenny's, Generalist all publish full content to RSS, so this isn't blocking.
4. **Dedup is downstream** — relies on the existing `preFlightCheck()` dedup gate in `lib/safety-guards.mjs`. Substack and career-page scanners will both find the same Kalshi role; the gate handles it.

## Open questions / future work

- Add a `mcp__mcp-registry__search_mcp_registry` re-check quarterly — if a real Substack MCP ships, swap RSS for it.
- Consider expanding to non-Substack newsletters with RSS (e.g. Hunter Walk's Homebrew updates, work-at-a-startup digests).
- Track per-feed conversion rate (listings extracted → applications submitted) and prune dead weight after 60 days.

## Next concrete step

Approve Phase 1 and I'll wire `scanSubstack()` into `orchestrator.mjs` with the shadow-log destination, plus add a Source-3 section to `CLAUDE.md`.
