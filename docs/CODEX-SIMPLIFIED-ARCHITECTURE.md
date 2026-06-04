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

The first implementation pass is stage-only. It scores roles, generates local material manifests, routes submissions, and writes the local ledger. Browser crawling and final submission hooks plug into this spine next.
