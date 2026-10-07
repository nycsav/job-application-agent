# Contract / Immediate-Start Queue — 2026-10-07

Goal: contracting work that starts now, to lift revenue. Deduped against the Notion
Career Command Center. No duplicates queued.

---

## 1. Mistral — interview scheduling  ✅ ANSWERED

Brian Cannon (brian.cannon@mistral.ai), Oct 7: 30-minute intro call, **self-scheduling
Ashby link** — he does not propose times, Sav picks from his calendar.

**Link:** https://you.ashbyhq.com/meeting/35e9d3a8-3996-464c-a6f0-a83f9315163d/

**Dedup note:** Notion shows **Mistral — AI Deployment Strategist, USA — Applied 2026-08-11.**
This is the response to that application, not a new role. Do not re-apply.

**Sav's free 30-min windows (9am–6pm ET, from her calendar):**

| Day | Free |
|---|---|
| Wed Oct 7 | 1:00–2:00 PM · 2:45–5:00 PM |
| Thu Oct 8 | 10:45 AM–12:15 PM · 12:30–5:30 PM |
| Fri Oct 9 | 9:45 AM–6:00 PM (wide open) |
| Mon Oct 12 | 9:45 AM–6:00 PM (wide open) |
| Tue Oct 13 | 9:45 AM–6:00 PM (wide open) |
| Wed Oct 14 | 9:45 AM–12:00 PM · 12:45–6:00 PM |
| Thu Oct 15 | 9:45 AM–12:00 PM · 1:00–6:00 PM |
| Fri Oct 16 | 5:00–6:00 PM only (Daytona HackSprint all day) |

**Recommendation: Thu Oct 8, 2:00 PM ET** — earliest slot with real buffer on both sides
(the 10:45 window is tight against the Hanwha Vision follow-up). Fri Oct 9 or Mon Oct 12
are the safest if Brian's calendar is thin.

Judgment call applied: three calendar blocks titled "⚠️ ACTION (2 min)" / "(60 sec)" are
reminder stubs padded across a whole workday by the event-digest skill, not real meetings.
They were treated as free. Without that, Oct 8 and Oct 15 would read as fully booked.

---

## 2. Designlab — Instructor, AI Workflows & Agents  ⬅ the Indeed job you forwarded

| | |
|---|---|
| Comp | **$90–$200 / hour** |
| Type | Part-time, **Contract** |
| Location | Remote (listed New York, NY) |
| Source | Indeed match email, Oct 7 — forwarded as "Designlab indeed job" |
| Dedup | **No Notion row. New.** |
| Resume | `Sav_Banerjee_Resume_2026_MD_ManagedServices.pdf` (contract track) |
| Status | **NOT submitted — needs a browser** |

Indeed's quick-apply is a web form. This cloud session has no browser, so it has to run on
the Mac. Top of the rate band ($200/hr) is well above the $85/hr contract floor.

---

## 3. Mindlance — Enterprise GenAI LLM Solution Architect  ✅ DRAFT READY TO SEND

| | |
|---|---|
| Recruiter | Alekh Pandey, alekhp@mindlance.com, 732-825-6949 |
| Location | New York City (Hybrid) |
| Duration | **6+ months**, extension likely — "Urgent hiring" |
| Preferred | Banking & capital markets, fraud domain |
| Dedup | **No Notion row. New.** |
| Status | **Gmail draft created — one tap to send** |

This one is recruiter-sourced, so the application *is* an email reply — no ATS form, no
browser needed. The draft leads with GenAI/LLM architecture plus the banking depth they
asked for (Citi, JPMorgan Chase, AmEx), confirms immediate availability, and offers three
concrete time windows from the calendar above. No metrics are quoted: `config/candidate.json`
was lost when this container recycled, and I will not cite numbers I cannot verify.

---

## 4. Ethos — Fractional CIO / CTO / Chief AI Officer, Healthcare & Life Sciences

| | |
|---|---|
| Comp | **$350 / hour** |
| Scope | Pharma, payers, providers |
| Source | LinkedIn job alert, Sep 29 |
| Dedup | No Notion row. New. |
| Status | Not submitted — needs a browser |

Highest hourly rate in the whole sweep, and the sector lines up with Sav's Pfizer and
Eli Lilly work. Strongest revenue-per-hour candidate on this list.

---

## 5. Needs your call before I act

**Mitchell Martin — Sr Python GenAI Developer (6 roles), long-term contract, Pennington NJ
or NYC hybrid.** Krishna Vasamshetti, KVasamshetti@itmmi.com, Sep 30.

Six open seats on a long-term contract is real revenue, but it is a hands-on Python
*developer* title — a level below AI strategy/architecture, and likely a lower rate than
the $350/hr fractional-CxO track. Applying down-level with an agency can also anchor how
they pitch you later. I did not draft a reply. Say the word and I will.

**Umbrex (Veritux) — "Interim CEO role and 16 other oppty", Sep 30.** Sav is already a
member of this consultant network, so these are warm, not cold. 17 opportunities in one
email is the densest contract-revenue source in the inbox. Worth a dedicated pass.

---

## Scan status — honest accounting

The `job-scan-morning` skill **halted at its own Step 0 pre-flight**, as designed:

| Check | Result |
|---|---|
| `candidate.json` (needs ≥20 `easy_apply_answers`) | ❌ **missing** — container recycled; it is gitignored so it never survives |
| `Sav_Banerjee_Resume_2026_v2.pdf` | ❌ not in this container |
| `master_cover_letter.md` | ❌ path absent |
| Chrome MCP browser | ❌ **0 connected** — Step 0 check 4 says halt |

Per the skill's own rule, zero connected browsers means halt and report rather than
proceed. So no auto-submit, no Sheet write, no briefing send happened.

What I ran instead, directly against the Gmail MCP: a 10-day sweep for contract, fractional,
1099, hourly, C2C and interim roles, plus the two specific emails asked for, deduped against
Notion. That is the discovery half. The submit half needs the Mac.

**To make the scan stop halting every time**, `config/candidate.json` has to live somewhere
that survives a fresh container — it is gitignored (correctly, it is PII), so each new cloud
session starts without it. Options: keep it in the Mac engine only and stop running this
skill from the cloud, or store it as an environment secret the session can rehydrate.
