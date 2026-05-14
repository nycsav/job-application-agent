# Generate Application Materials

Generate tailored resume and cover letter for new high-score roles.

## Trigger
Runs after daily-scan when new score 8+ roles are found, or on-demand.

## Steps

1. **Read current state:**
   - Read `job-engine/config/roles.json`
   - Find all roles where status is NOT 'materials_ready'
   - Read `job-engine/config/candidate.json` for the full candidate profile

2. **For each pending role:**

   a. **Generate cover letter hooks** (if not already present):
      - Fetch the full job description from the apply_url using web_fetch
      - Analyze requirements against candidate profile
      - Confirm or override the resume cluster using JD-aware matching (JD content overrides title-based assumptions — see daily-scan.md Step 6 PASS 2 for full logic)
      - Write cover_letter_hooks following the pattern of existing roles in roles.json:
        - opener: A punchy 1-2 sentence opening that establishes immediate credibility
        - why_fit: 4 bullet points connecting specific candidate achievements to role requirements
        - closer: A confident 1-sentence closing that names the core problem the role solves
      - Save hooks to roles.json

   b. **Generate resume:**
      - Use the template engine pattern from `job-engine/lib/template-engine.mjs`
      - Apply role-specific summary_override and competencies_override if present
      - Reorder certifications to lead with the most relevant for this company
      - Select portfolio URLs based on portfolio_focus array

   c. **Generate cover letter:**
      - Use the template engine pattern from `job-engine/lib/template-engine.mjs`
      - Fill the master_cover_letter.md template with role-specific hooks

   d. **Quality Gate — Score both materials:**
      - Run the quality scorecard from `routines/quality-scorecard.md`
      - Score resume against criteria A1-D4 (100 points)
      - Score cover letter against criteria E1-H3 (100 points)
      - BOTH must score 85+ to proceed
      - If either fails: fix flagged criteria, re-generate affected sections, re-score
      - Log scores in report output

   e. **Convert to .docx:**
      - Use `job-engine/lib/docx-builder.mjs` pattern
      - ATS formatting: Arial 11pt, single column, no graphics, standard headers
      - Filename: Sav_Banerjee_{Company}_{Title}_Resume.docx / _CoverLetter.docx

   f. **Upload to Google Drive:**
      - Upload both files to folder ID: 1OOsMcQMegAUg5Ezy47rqiPh7ZAnBZHto
      - Record the Drive file URLs

   g. **Update tracking:**
      - Set role status to 'materials_ready' in roles.json
      - Add resume_url and cover_letter_url fields
      - Update Google Sheet row with Drive links

3. **Report:**
   - Log which roles got materials generated
   - Note any failures

## Quality Rules
- Use EXACT metrics from candidate.json verified_metrics — don't round or approximate
- Every cover letter must reference at least one live URL (ensolabs.ai/work/*)
- Resume must be single-page if possible (cut older roles to 1 bullet if needed)
- Cover letter should be under 400 words
- Never mention confidential client names (use "Global Materials Manufacturer" for Gore)
