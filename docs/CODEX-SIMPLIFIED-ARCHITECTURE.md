# Codex Branch: Local-First Job Agent Architecture

This branch keeps the original project as reference material and builds a simpler local-first workflow in this workspace.

## Working Shape

```mermaid
flowchart TD
  A["Scheduler: 9 AM + 4 PM"] --> B["Browser Saved-Job Crawler"]
  B --> C["Normalize Role"]
  C --> D["Fetch / Attach Full JD"]
  D --> E["Hard Filters"]
  E -->|fail| F["Skip + Log Reason"]
  E -->|pass| G["Score Role"]
  G --> H["Local State Store"]
  H -->|score 5-6| I["Track"]
  H -->|score 7| J["Priority"]
  H -->|score 8+| K["Materials Agent"]
  K --> L["Resume Cluster + Tailored Cover Letter"]
  L --> M["Submission Router"]
  M --> N["Human Approval Gate"]
  N -->|approve| O["Submit / Apply4Me / Direct ATS"]
  N -->|hold| P["Keep Staged"]
  O --> Q["Confirmation + Screenshot + Ledger"]
```

## Simplification Points

- One canonical role object for every source.
- One local state ledger before any external sync.
- One policy file for filters, scoring thresholds, and submission routing.
- One materials path that starts from trusted local resume clusters.
- One submission router that decides Apply4Me, direct ATS, or manual assist.
- Browser automation is used only after the role passes filters and scoring.
- Human approval is a required state transition, not a loose instruction.

## New Entry Points

- `npm run codex:pipeline -- --fixture reports/parallel-scan-fixture.json`
- `npm run codex:pipeline` after adding `input/saved-jobs.json` or `input/saved-jobs.csv`
- `npm run codex:test`
- `npm run codex:resume-match -- --job-json input/<job>.json`

The first implementation pass is stage-only. It scores roles, generates local material manifests, routes submissions, and writes the local ledger. Browser crawling and final submission hooks plug into this spine next.

## Learning Loop

- Run reflection: `docs/CODEX-RUN-LEARNINGS-2026-06-04.md`
- Machine-readable policy: `config/codex-learning-policy.json`

The current feedback policy rewards the sequence: extract JD, compare actual resume text, explain the resume choice, ask for cover-letter positioning, fill only after approval, stop at final review, and archive processed source emails.

## Strategic Archetype Scoring

Approved target archetypes live in `config/codex-role-archetypes.json` and are used by `lib/codex-archetypes.mjs`.

| Archetype | Priority | Resume Route |
| --- | --- | --- |
| Forward-Deployed AI Strategist / Solution Principal | Highest | Forward-Deployed AI Architect |
| VP / Director AI Transformation | Highest | AI Advisory, with MD Managed Services as secondary |
| Lead AI Consultant / Principal AI Advisor | Highest | AI Advisory |
| Agentic AI Platform / AI Solutions Architect | High | Forward-Deployed AI Architect |
| AI CoE / Managed Services / Implementation Partner | High | MD Managed Services |
| AI Product Strategy / GTM / Partnerships | Medium-High | PMM / GTM |

The role scorer now returns the best archetype, strategic-fit band, top archetype matches, and the normal 0-10 score. Resume routing uses the winning archetype before falling back to generic keyword rules.

## Three-Way Alignment Scoring

The scorer also uses `config/codex-alignment-model.json` and `lib/codex-alignment.mjs` to reward roles where three signals agree:

1. **Candidate evidence corpus:** Enso Labs, case studies, LinkedIn, and the optimized resume set prove the capability.
2. **Current market language:** recent job descriptions in the archetype category ask for the same capabilities.
3. **Individual JD fit:** the specific role description uses the same language and responsibilities.

This produces:

- `candidateCorpusFit`
- `marketCategoryFit`
- `jdArchetypeFit`
- overall `alignment.score`
- alignment flags such as `weak_candidate_evidence_overlap`, `weak_current_market_pattern_overlap`, `likely_too_ic_engineering`, and `legacy_advertising_without_ai_pivot`

This is the practical reinforcement-learning loop: the agent rewards roles where background, market, and JD align; it penalizes roles that are only superficially senior or only weakly connected to the strategic pivot.

## ATS Resume Set

- Resume optimization note: `docs/ATS-RESUME-OPTIMIZATION.md`
- Build command: `npm run codex:build-ats-resumes`
- Audit command: `npm run codex:audit-ats-resumes`

The active resume map points to ATS-optimized private DOCX files in `materials/resumes/optimized/`. These files are generated locally and intentionally excluded from git.
