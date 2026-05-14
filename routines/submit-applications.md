# Submit Applications

Fill and submit job applications for roles with materials ready.

## Trigger
On-demand only — never auto-scheduled. Run manually via:
`claude "Submit applications for ready roles"`

## Prerequisites
- Playwright MCP connected (`@anthropic/playwright-mcp`)
- OR Claude in Chrome extension active
- Materials already generated (role status = 'materials_ready')
- .docx files available in Google Drive

## Steps

1. **Read current state:**
   - Read `job-engine/config/roles.json`
   - Filter for roles with status === 'materials_ready'
   - Sort by score (highest first)
   - Read `job-engine/config/candidate.json` for form data
   - Read `job-engine/agents/submitter.mjs` for platform strategies

2. **For each ready role:**

   a. **Prepare:**
      - Download resume and cover letter .docx from Google Drive to /tmp
      - Load the platform strategy (greenhouse, ashby, lever, google_careers, custom)
      - Prepare form data from candidate profile

   b. **Navigate and fill:**
      - Open the apply_url in the browser
      - Click the Apply button
      - Fill each form field using the platform strategy's selectors:
        - Name, email, phone, LinkedIn, website
        - Upload resume .docx
        - Upload cover letter .docx (or paste into text area)
        - Answer additional questions using candidate profile context
      - For common questions:
        - "Why are you interested?": Use the role's cover_letter_hooks.opener
        - "Work authorization?": "Authorized to work in the US"
        - "Sponsorship required?": "No"
        - "Salary expectations?": "Open to discussion based on total compensation"
        - "How did you hear about us?": "Direct application"

   c. **⚠️ MANDATORY STOP — HUMAN APPROVAL:**
      ```
      STOP HERE. DO NOT CLICK SUBMIT.
      
      Take a screenshot of the completed form.
      Show it to Sav with the message:
      
      "Ready to submit application for [Company] — [Title].
       Score: [X]/10. Platform: [platform].
       Resume: [filename]. Cover letter: [filename].
       
       Approve submission? (yes/no)"
      
      Wait for explicit approval before proceeding.
      ```

   d. **If approved:**
      - Click Submit
      - Take a screenshot of the confirmation page
      - Record any confirmation number
      - Update role status to 'applied' in roles.json
      - Update Google Sheet with: application date, status, confirmation

   e. **If rejected:**
      - Update role status to 'paused' in roles.json
      - Note the reason
      - Move to next role

3. **Send summary email:**
   - To: sav@ensopartners.co
   - Subject: "Applications Update — {date}"
   - Body: List of submitted and paused applications

## Critical Safety Rules
- NEVER auto-submit without human approval
- NEVER apply to Perplexity (exclusion list)
- If login/authentication is required, STOP and ask user to log in manually
- If CAPTCHA appears, STOP and ask user to complete it
- If any form field is unclear, STOP and ask user
- Take screenshots at every major step for audit trail
