# ATS Resume Optimization

The Codex branch now uses four ATS-optimized resume derivatives for the approved strategic archetypes.

## Optimized Files

Generated locally by `scripts/build-ats-resumes.py`:

- `materials/resumes/optimized/Sav_Banerjee_Resume_ForwardDeployed_ATS_2026.docx`
- `materials/resumes/optimized/Sav_Banerjee_Resume_AI_Transformation_ATS_2026.docx`
- `materials/resumes/optimized/Sav_Banerjee_Resume_MD_ManagedServices_ATS_2026.docx`
- `materials/resumes/optimized/Sav_Banerjee_Resume_PMM_GTM_ATS_2026.docx`

These files are intentionally not committed because `materials/` is private and contains personal resume data.

## ATS Formatting Rules

- Single-column flow.
- No layout tables.
- No text boxes.
- No drawings, icons, or embedded images.
- No tracked changes, comments, footnotes, or endnotes.
- Plain name, headline, and contact block.
- Standard Word paragraph styles.
- Real Word list styles for bullets.
- Keyword section kept readable, not stuffed.

## Market Language Included

The optimized versions emphasize current executive AI transformation and deployment-strategy language:

- Agentic AI architecture
- MCP tool integration
- Managed Agents API
- Claude, Gemini, and frontier-model deployment
- LangGraph, RAG, evaluation, and observability
- Pilot-to-production
- Operating model and delivery model
- AI Center of Excellence
- C-suite stakeholder alignment
- Executive value realization
- Enterprise deployment and production systems
- React / Next.js, TypeScript, APIs, CI/CD release patterns where supported by portfolio evidence

## QA Commands

```bash
npm run codex:build-ats-resumes
npm run codex:audit-ats-resumes
npm run codex:resume-match -- --job-json input/<job>.json
```

`codex:audit-ats-resumes` fails if a resume contains ATS-hostile structures or misses the configured target keyword set.

## Current Limitation

Visual DOCX render QA is blocked in this local runtime because the bundled LibreOffice binary is missing the native `little-cms2` library. Structural DOCX and ATS-object QA passes, but PNG render review could not be completed until LibreOffice is repaired or installed locally.
