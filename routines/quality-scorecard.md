# Materials Quality Scorecard

Run this scorecard on EVERY resume and cover letter BEFORE converting to .docx and uploading to Drive. Materials must score 85+ to pass. If below 85, fix the failing criteria and re-score before proceeding.

---

## RESUME SCORECARD (100 points total)

### A. ATS Compatibility (25 points)
| # | Criterion | Points | How to Check |
|---|-----------|--------|--------------|
| A1 | Single-column layout, no tables/graphics/columns | 5 | Visual inspection — ATS cannot parse multi-column or table-based layouts |
| A2 | Standard section headers (Summary, Experience, Education, Skills, Certifications) | 5 | Headers must use exact conventional names — not creative alternatives |
| A3 | Font is Arial or Calibri, 10-12pt body, consistent sizing | 5 | docx-builder.mjs enforces Arial 11pt — verify no overrides |
| A4 | Reverse chronological order within Experience | 5 | Most recent role first, each role has explicit date range |
| A5 | File format .docx (not PDF for ATS submission) | 5 | Verify output extension |

### B. Keyword Optimization (25 points)
| # | Criterion | Points | How to Check |
|---|-----------|--------|--------------|
| B1 | 70%+ keyword match with job description | 10 | Extract top 15 keywords/phrases from JD, count how many appear verbatim in resume |
| B2 | Keywords appear WITHIN dated job entries (not just skills section) | 5 | ATS weights in-context keywords 2-3x higher than standalone lists |
| B3 | Job title in resume summary mirrors target role language | 5 | If JD says "Chief Transformation Officer," summary should use "transformation" and "chief/executive" |
| B4 | Industry-specific terminology from JD is present | 5 | PE/consulting terms for PE roles, technical terms for tech roles, etc. |

### C. Content Quality (30 points)
| # | Criterion | Points | How to Check |
|---|-----------|--------|--------------|
| C1 | Every bullet starts with a strong action verb (Led, Architected, Delivered, Built, Drove) | 5 | No bullets starting with "Responsible for" or passive voice |
| C2 | 80%+ of bullets contain a quantified metric | 5 | Numbers, percentages, dollar amounts, timeframes — not vague claims |
| C3 | ALL metrics match candidate.json verified_metrics exactly | 5 | Cross-reference every number against the source. Zero tolerance for fabrication or rounding |
| C4 | No duplicate sections, no repeated bullets | 5 | Scan for any copy-paste errors |
| C5 | Top 3 bullets in current role directly address JD's top 3 requirements | 5 | Map JD requirements → resume bullets 1:1 |
| C6 | 4-6 bullets per major role, 1-2 for older roles | 5 | Recent roles get depth, older roles get brevity |

### D. Executive Positioning (20 points)
| # | Criterion | Points | How to Check |
|---|-----------|--------|--------------|
| D1 | Summary reads as a positioning statement, not a job description | 5 | Should communicate: who you are, what you do, why it matters, scale of impact |
| D2 | Portfolio/project links included (ensolabs.ai/work/*) | 5 | At least 2 live URLs demonstrating shipped work |
| D3 | Client names are public-only (Gore → "Global Materials Manufacturer") | 5 | Cross-check against candidate.json confidential_clients |
| D4 | Education, certifications are complete and accurate | 5 | Full degree name, school name, relevant certs ordered by relevance to target role |

---

## COVER LETTER SCORECARD (100 points total)

### E. Structure & Format (20 points)
| # | Criterion | Points | How to Check |
|---|-----------|--------|--------------|
| E1 | Under 400 words | 5 | Word count check |
| E2 | 3-4 paragraphs maximum | 5 | Opening hook, evidence body (1-2 paragraphs), closing with CTA |
| E3 | Company and role named explicitly | 5 | Not generic — must reference the specific company |
| E4 | No resume bullet repetition — complements, doesn't duplicate | 5 | Cover letter explains fit and motivation; resume lists achievements |

### F. Opening Hook (20 points)
| # | Criterion | Points | How to Check |
|---|-----------|--------|--------------|
| F1 | First sentence establishes credibility in under 25 words | 10 | No "I am writing to apply" — lead with a claim or insight |
| F2 | Opening paragraph connects candidate to the company's specific challenge | 10 | Must reference something specific about the company or role, not generic industry trends |

### G. Evidence & Fit (35 points)
| # | Criterion | Points | How to Check |
|---|-----------|--------|--------------|
| G1 | References 2-3 specific JD requirements by name | 10 | Don't paraphrase — use the JD's own language |
| G2 | Each JD requirement is matched with a specific, quantified achievement | 10 | "You need X → I delivered Y (metric)" pattern |
| G3 | All metrics match candidate.json verified_metrics exactly | 10 | Same zero-tolerance rule as resume |
| G4 | At least one live portfolio URL (ensolabs.ai/work/*) | 5 | Gives the reader something to click and verify |

### H. Closing & Differentiation (25 points)
| # | Criterion | Points | How to Check |
|---|-----------|--------|--------------|
| H1 | Builder + strategist differentiator is clear | 10 | The key message: "I don't just advise, I build and ship" — this is Sav's core edge |
| H2 | Closing names the core problem the role solves and positions Sav as the solution | 10 | Not generic "I look forward to hearing from you" |
| H3 | Availability and logistics addressed (location, start date, travel) | 5 | Especially important for contract/consulting roles |

---

## SCORING THRESHOLDS

| Score | Grade | Action |
|-------|-------|--------|
| 90-100 | A | Upload immediately — exceptional quality |
| 85-89 | B+ | Upload — meets quality bar |
| 75-84 | B | Fix flagged issues, re-score before upload |
| 65-74 | C | Major revision needed — multiple criteria failing |
| Below 65 | F | Regenerate from scratch |

**Minimum passing score: 85 for BOTH resume and cover letter.**

---

## HOW TO USE THIS SCORECARD

After generating resume and cover letter text (Step 2c in generate-materials.md), BEFORE converting to .docx:

1. Score the resume against criteria A1-D4 (100 points)
2. Score the cover letter against criteria E1-H3 (100 points)
3. List every criterion that lost points with a specific reason
4. If either score is below 85:
   - Fix the failing criteria
   - Re-generate the affected sections
   - Re-score to confirm 85+
5. Only proceed to .docx conversion and Drive upload after both score 85+
6. Log both scores in the Google Sheet row (Resume Score, Cover Letter Score columns)

---

## COMMON FAILURES TO WATCH FOR

1. **Fabricated metrics** — Any number not in candidate.json verified_metrics is an automatic 0 on C3/G3 (minus 15 points total). This alone can fail the scorecard.
2. **Duplicate sections** — Copy-paste errors from template merging. Check C4.
3. **Generic cover letter opening** — "I am excited to apply" = 0 on F1 and F2 (minus 20 points).
4. **Missing dates** — Every role must have explicit date ranges. Undated roles look fabricated to recruiters.
5. **Keyword stuffing** — Keywords must appear naturally within achievement bullets, not crammed into a skills section.
6. **Gore mentioned by name** — Automatic confidentiality violation. Always "Global Materials Manufacturer."
7. **Resume over 2 pages** — For executive roles, 2 pages max. Cut older roles to 1 bullet each.

---

## BENCHMARK SOURCES

This scorecard synthesizes best practices from:
- LinkedIn Talent Solutions recruiter research (2025-2026)
- Indeed Career Guide ATS optimization standards
- Google hiring team published resume guidance
- Anthropic job application best practices
- ATS platform testing (Workday, Greenhouse, Lever, Ashby, iCIMS)
- Resume Optimizer Pro dataset (12,000+ optimization runs, 2026)
