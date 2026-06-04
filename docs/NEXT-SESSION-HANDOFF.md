# Next Session Handoff

Updated: 2026-06-04

This branch is ready for the next Codex launch. The original source folder remains untouched; all active work is in `/Users/savbanerjee/Documents/Job-Application-Agent` on branch `Codex`.

## Git State

- Remote repo: `https://github.com/nycsav/job-application-agent`
- Branch: `Codex`
- Latest pushed commit: `259a067 Add ATS optimized resume set`
- Working tree was clean before this handoff note was added.

## What Is Built

- Local-first, human-gated application pipeline.
- Strategic role archetype scoring for six approved target lanes.
- Resume/JD matching gate before application submission.
- ATS-optimized private resume set generated locally.
- Gmail multi-account scanner with processed-email cleanup.
- Learning policy and run reflection.

## Private Local Files

These files exist locally and are intentionally excluded from git:

- `materials/resumes/optimized/Sav_Banerjee_Resume_ForwardDeployed_ATS_2026.docx`
- `materials/resumes/optimized/Sav_Banerjee_Resume_AI_Transformation_ATS_2026.docx`
- `materials/resumes/optimized/Sav_Banerjee_Resume_MD_ManagedServices_ATS_2026.docx`
- `materials/resumes/optimized/Sav_Banerjee_Resume_PMM_GTM_ATS_2026.docx`
- `input/softserve-agentic-solution-principal.json`
- `output/resume-matches/softserve-agentic-solution-principal/resume-match-report.md`
- local Gmail credentials/tokens, if present

## Key Commands

```bash
npm run codex:test
npm run codex:build-ats-resumes
npm run codex:audit-ats-resumes
npm run codex:resume-match -- --job-json input/<job>.json
npm run codex:gmail
npm run codex:pipeline
```

## Current Application State

SoftServe `Agentic Solution Principal` was analyzed and staged earlier, but the current in-app browser tab is no longer on LinkedIn.

Known SoftServe recommendation:

- Archetype: Forward-Deployed AI Strategist / Solution Principal
- Resume: `Sav_Banerjee_Resume_ForwardDeployed_ATS_2026.docx`
- Match score after ATS optimization: `91/100`
- Remaining tailoring gap: `microservices / C4`

Before submitting SoftServe:

1. Re-open LinkedIn job: `https://www.linkedin.com/jobs/view/4411438474/`
2. Confirm the application is still available and not already submitted.
3. Upload/use `materials/resumes/optimized/Sav_Banerjee_Resume_ForwardDeployed_ATS_2026.docx`.
4. Confirm answers:
   - Agentic AI Development: `5`
   - Travel within USA: `Yes`
5. Stop at final review.
6. Submit only after explicit action-time approval from Sav.

## Approved Role Archetypes

| Archetype | Priority | Resume Route |
| --- | --- | --- |
| Forward-Deployed AI Strategist / Solution Principal | Highest | Forward-Deployed AI Architect |
| VP / Director AI Transformation | Highest | AI Advisory or MD Managed Services |
| Lead AI Consultant / Principal AI Advisor | Highest | AI Advisory |
| Agentic AI Platform / AI Solutions Architect | High | Forward-Deployed AI Architect |
| AI CoE / Managed Services / Implementation Partner | High | MD Managed Services |
| AI Product Strategy / GTM / Partnerships | Medium-High | PMM / GTM |

## Next Launch Workflow

For LinkedIn, Ladders, Indeed, or company websites:

1. Extract the full JD first.
2. Classify the role archetype.
3. Run the resume/JD matcher against the optimized ATS resume set.
4. Present the recommended resume, runner-up, rationale, and tailoring gaps.
5. Ask for cover-letter positioning if the application supports a cover letter or direct ATS upload.
6. Fill application forms only after material choice is approved.
7. Pause at final review.
8. Submit only after explicit user approval.
9. Log confirmation and archive processed source emails to `Codex Job Applications`.

## Known Blockers

- Gmail cleanup requires OAuth tokens with `gmail.modify`; old read-only tokens may need reauthorization.
- DOCX visual render QA is blocked because bundled LibreOffice is missing native `little-cms2`. Structural ATS audit passes.
- LinkedIn session state may need to be restored or re-authenticated next launch.
