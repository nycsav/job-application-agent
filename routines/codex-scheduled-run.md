# Codex Scheduled Job Agent Run

Run the local-first Job Application Agent in stage-only mode.

## Rules

- Do not submit applications automatically.
- Use local files and the local ledger as the system of record.
- Stop if browser login, CAPTCHA, or native OS file picker blocks progress.
- Stage any score 8+ roles for human approval.
- Save generated materials and run summaries locally.

## Command

```bash
npm run codex:pipeline
```

## Expected Output

- `data/applications.json` updated with scored roles and statuses.
- `data/runs/` updated with a per-run summary.
- `output/materials/` populated for score 8+ roles.
- Any role requiring submission should remain `staged_for_approval`.
