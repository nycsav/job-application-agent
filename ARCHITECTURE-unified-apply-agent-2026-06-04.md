# Unified Application Agent — Architecture (2026-06-04)

One agent, every platform. Deployable immediately on the existing daily scheduled task (`job-scan-morning`) running on the always-on Mac Mini work Chrome (Ladders Premium now active).

## The key insight (from research, 2026-06-04)
The **Ladders Apply4Me "Magic" Chrome Extension** injects a one-click Apply4Me button onto **LinkedIn, Indeed, ZipRecruiter, Glassdoor, Monster, CareerBuilder, and ~208,000 corporate career sites**. Clicking it routes the role to Ladders' human team, who complete the full application on Sav's behalf with her profile resume (v3 docx) + stored cover letter. This is the **single cross-platform submission mechanism** — no per-site form-filling, no LinkedIn-ToS/ban risk (we never puppet LinkedIn's own apply flow), confirmations land in the Enso inbox.
- **Constraint:** Premium = **50 Apply4Me applications / month**. Source: theladders.com/apply4me-extensions.

## Pipeline
1. **Discover (parallel-scanner.mjs — built):** LinkedIn (Dice-backed search MCP) · Ladders (Enso inbox via Gmail MCP) · Indeed (MCP) · JobRight. Normalize to one role list, last 7 days.
2. **Filter + gate:** hard filters (salary ≥ $180K / $85+/hr contract; NYC/Remote/Hybrid-NYC; exclude Perplexity/BOI/Sia) → `scoreRole()` → `roleQualificationGate()` (skip CS-degree-required + hands-on IC engineer). Keep **score ≥ 8**.
3. **Dedup:** company+title and job-ID against Notion "Applied" + Apply4Me confirmations (already-applied: GoodRx, Citigroup ×2, Capgemini, Dell). Company-alias map ("Capital One" == "Capital One Financial Corporation").
4. **Submit — unified via Apply4Me:**
   - Ladders-sourced roles → Apply4Me button on the Ladders job page.
   - LinkedIn / Indeed / ZipRecruiter / Glassdoor / corporate roles → Apply4Me **Magic Extension** injected button.
   - **Pace ~10–15/day** so the 50/month cap isn't exhausted in one run; prioritize highest score first.
   - **Dream roles** (Priority=DREAM) → SKIP Apply4Me; hand-tailor a rewritten resume + bespoke cover letter and apply on the company ATS directly (perfect match).
   - **Overflow beyond 50/month** → direct-ATS daemon (Greenhouse/Lever/Ashby), free, no Ladders dependency. (Phase 2.)
5. **Track (auto):** Notion Career Command Center (Status=Applied, date, resume, fit reason) · Gmail label **Claude Application Agent/Ladders** (confirmations filed + archived from inbox) · Cowork **Application Tracker** artifact (updated via `update_artifact` each run).
6. **Briefing:** in-chat / Cowork artifact, not email.

## Resume + cover letter policy
- **Apply4Me (volume):** profile resume = **v3 docx** (Apply4Me requires .docx, not PDF) + the stored templated cover letter (merge tags `Job_title` / `Company_name` auto-personalize).
- **Dream roles (bespoke):** pick the right base of the 4 (v3 / MD / PMM / Forward-Deployed) → rewrite summary + top bullets to the JD's title and keywords (metrics always exact) → export PDF → custom cover letter → direct ATS.

## Deploy steps (immediate)
1. Update `job-scan-morning` submit step: replace the LinkedIn-Easy-Apply daemon with the Apply4Me + Magic-Extension click flow (Ladders page button for Ladders roles; Magic Extension button on LinkedIn/Indeed/etc.). Keep gate + dedup + caps.
2. Confirm the Magic Extension is installed + signed in on the Mac Mini work Chrome (Sav added it 2026-06-03).
3. Set daily Apply4Me budget = 12 (≈ stays under 50/month with buffer).
4. Each run: scan → filter → gate → dedup → submit up to budget (highest score first) → log to Notion → file confirmations → update Cowork tracker → briefing.

## Honest limits
- 50 Apply4Me/month is the ceiling for the human-completed channel; 100+ matches means we work the top-scored ~50/month via Apply4Me and build the direct-ATS daemon for the rest.
- Apply4Me uses ONE profile resume for all its submissions — true per-JD resume tailoring only happens on the bespoke/direct path.
- See [[project_autoapply_mechanism]], [[project_apply4me_setup]] in memory.
