# Submit list — ready to run, 2026-10-07

Built from the Notion Career Command Center: every row at **Approved** or **Materials Ready**,
then deduplicated, exclusion-filtered, and rescaled. 104 raw rows → **28 unique, submit-ready.**

## 🛑 STOP — one row must never be submitted

**Perplexity — AI Strategist, Financial Services — Status: Materials Ready, Fit 9.5**

Perplexity is a hard exclusion in `CLAUDE.md`, in `candidate.json.exclude_companies`, and in
`resume_map.json.excluded_companies`. The Google Sheet also carries **Perplexity — Head of
Solutions Engineering** flagged "SAV APPLIES PERSONALLY."

If anything bulk-submits everything marked Materials Ready, it applies to Perplexity and breaks
your own rule. **Archive that Notion row before any batch run.** Same for BOI / Board of Innovation.

---

## Tier 1 — submit first (7, then pause per the batch guard)

| # | Company | Role | Fit | URL |
|---|---------|------|-----|-----|
| 1 | Toast | Director, Marketing AI Transformation | 9.6 | dice.com/job-detail/515860dc-03b7-4bfe-9818-1fd95b5fa45e |
| 2 | EY-Parthenon | AI Business Solutions — Senior Director | 9.4 | dice.com/job-detail/07965f2d-756a-46dd-8721-baa31ff4f499 |
| 3 | BDO USA | AI Transformation Technology Enablement & Platform Leader | 9.5 | linkedin.com/jobs/view/4452574957 |
| 4 | New York Life | Corporate VP, Director, AI Search | 9.2 | careers.newyorklife.com/careers/job/41554687 |
| 5 | Genesys | Senior Director, Sales AI Strategy & Transformation | 9.1 | linkedin.com/jobs/view/4448474292 |
| 6 | Zeno Group | SVP, AI & Technology Programs | 9.1 | djeholdings.wd5.myworkdayjobs.com — JR102691-1 |
| 7 | Cuesta Partners | Principal, AI & Data Strategy — **already Approved** | 8.5 | jobs.ashbyhq.com/cuesta-partners |

**→ PAUSE. Summary + explicit "continue" before the next 7 (max 7/session).**

## Tier 2

| # | Company | Role | Fit | URL |
|---|---------|------|-----|-----|
| 8 | Citi | MD C16 — Head of AI Solutions, COO Technology | 9.0 | jobs.citi.com/job/new-york/...287/98062867120 |
| 9 | Mastercard | VP, Product — AI Center of Excellence | 9.0 | careers.mastercard.com/us/en/job/R-282197 |
| 10 | Pfizer | VP, AI COE Product Management & Adoption | 9.0 | pfizer.wd1.myworkdayjobs.com — 4960940-1 |
| 11 | Horizon Media | VP, AI (Agentic Platforms & Transformation) | 9.0 | linkedin.com/jobs/view/4446699868 |
| 12 | Salesforce | SVP, PM — MuleSoft Agent Fabric & AI Control Plane | 9.0 | via Ladders |
| 13 | Dell | Advisory AI Architect (FDE Unit) | 9.0 | dell.wd1.myworkdayjobs.com — r287595-1 |
| 14 | Miro | AI Technical Architect — **already Approved** | 9.0 | miro.com/careers/vacancy/8646854002 |

## Tier 3

| # | Company | Role | Fit |
|---|---------|------|-----|
| 15 | Anthropic | Product Marketing Lead, GTM Strategy — Claude for Knowledge Work | 8.7 |
| 16 | Anthropic | Forward Deployed Engineer | 9.0 |
| 17 | Anthropic | Applied AI Architect, Partnerships | 8.8 |
| 18 | Anthropic | Strategy & Operations, Applied AI — AMER | 8.4 |
| 19 | Novartis | Executive Director, Head of Agentic Factory (Remote) | 8.7 |
| 20 | OpenAI | Agency Partner, Ads Solutions | 8.6 |
| 21 | TIAA | Senior Managing Director — AI Strategy & Enterprise Applications | 9.0 |
| 22 | Citi | AI Product Strategy & Agentic Solutions, Liquidity Mgmt — Director | 9.0 |
| 23 | EXL Service | VP — Sr. AI Consulting Architect & Client Partner | 9.0 |
| 24 | Broadridge | VP, Forward Deployed Engineering — AI | 9.0 |
| 25 | Brillio | AI Architect — Healthcare AI Transformation | 9.0 |
| 26 | Janus Henderson | Head of AI Business Partners | 9.0 |
| 27 | Guidewire | VP, Global Practices — Professional Services | 9.0 |
| 28 | Help Scout | VP of Marketing | 8.4 |

---

## Data problems that will bite a bulk run

1. **Perplexity is queued.** See above. Hard stop.
2. **Two score scales in one column.** Toast 96, EY-Parthenon 94, Anthropic 87, Cuesta 85,
   Help Scout 84 are 0–100; everything else is 0–10. Any `fit >= 9` filter silently includes
   all five and excludes nothing — and a `fit <= 10` filter drops the five best roles.
3. **Horizon Media VP, AI is one job logged 8 times** (Aug 16, Aug 21, Aug 28, Aug 29, Aug 30,
   Sep 11, Sep 18, Sep 20). Also duplicated: Citi MD C16 ×2, Citi Liquidity ×2, Mastercard
   AI COE ×3, Mastercard FDE ×2, Dell ×2, Brillio ×2. Submitting the raw list means
   8 applications to the same Horizon Media req. That is the thing most likely to hurt you.
4. `lib/dedup.mjs` exists in this repo and is not wired into row creation. That is the fix.

## Where this morning's Cowork run is not

I checked all three systems of record:

| Source | Latest activity | This morning? |
|---|---|---|
| Notion Career Command Center | newest Materials Ready row **2026-09-20** | no |
| Google Sheet "Sav Job Tracker 2026" | newest scan stamp **2026-05-11** | no |
| Cloud session list (your account) | only job-related session is **2026-09-14**, archived, ended blocked on permissions | no |

Today's only running session is "Jyotish agent status inquiry" (iOS). Nothing job-related ran
in the cloud today, and nothing wrote to Notion or the Sheet.

If Cowork ran in the **desktop app on your Mac**, that is local-only: its session is not in the
cloud list and I cannot read or message it from here. Its output is on your machine.
