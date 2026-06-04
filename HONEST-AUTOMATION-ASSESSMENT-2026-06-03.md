# Honest Automation Assessment — 2026-06-03

You asked for an honest check and full accountability. Here it is, including the
parts you won't love. I'd rather lose the "yes to everything" points than set us
up for another month of the same disappointment.

## The headline
**I can automate the pipeline up to the submit button at ~80%. I cannot honestly
promise 75–80% of submissions *completed autonomously* this morning, and no one
can promise a "100% success rate."** Those two targets are the exact trap that's
cost us months. Here's the real picture and a target that's both honest and still
a step-change.

## Per-stage automation (daily, realistic)

| Stage | Automatable | Why it's capped there |
|---|---|---|
| Discover (LinkedIn-MCP/Dice + Ladders + JobRight + Gmail) | **95%** | Solid. Main fix was breadth — keywords were too narrow (below). |
| Score + dedup + hard filters | **95%** | `scoreRole()` + gates run clean. |
| Resume selection | **90%** | Router was *broken* (pointed at 2 nonexistent files) — fixed today. |
| Cover-letter draft | **85%** | Good drafts; dream roles still deserve a human read. |
| Package / pre-fill application | **60–70%** | Varies wildly by ATS. |
| **Click "submit"** | **15–30%** | **The wall. See below.** |

## Why submission is the wall (not fixable by trying harder)
1. **LinkedIn ToS.** Automated applying violates LinkedIn's User Agreement and
   trips security checkpoints/CAPTCHAs → account restriction or ban. The
   connected "LinkedIn" MCP is actually a **Dice-backed search API** — it finds
   jobs, it **cannot submit**. There is no sanctioned auto-submit path into
   LinkedIn.com.
2. **External ATS** (Greenhouse/Ashby/Lever/Workday) need logins, knockout/EEO
   questions, and resume-parse confirmation. Many run bot protection. A daemon
   handles a *subset*, brittly.
3. **Your own safety rule** (CLAUDE.md): "NEVER auto-submit without human
   approval; if CAPTCHA or login required, STOP." The 75–80% autonomous-submit
   goal contradicts the architecture you already chose for good reasons.

## The reframe that's honest AND a big win
Move the bottleneck from **hours of writing** to **minutes of clicking.**
- **This morning's realistic target:** a batch of 8+ FTE roles **plus** $85/hr+
  consulting roles — each fully scored, resume-matched, cover-letter-drafted,
  and staged in Notion as *Materials Ready*, every one a **1–2 click confirm**.
- You approve the batch. The Easy-Apply daemon clears the *legitimately* Easy-
  Apply subset under the gate; custom ATS get a pre-filled handoff link.
- "Success rate" we can actually own = **% of strong roles that reach ready-to-
  submit the same day.** Target 90%+. Interview/offer rates depend on the market,
  not the pipeline — I won't pretend otherwise.

## Your 4 questions, answered straight
1. **Resumes + cover letters?** Yes — now. Router fixed (5 routes resolve),
   proved end-to-end with a real Acxiom cover letter (verified metrics, live URL).
2. **Consulting / >$85/hr?** Done — added a parallel hourly track ($85/hr floor)
   + a contract specialist + the MD/Managed-Services resume route. Verified:
   $90/hr passes, $70/hr drops.
3. **Front end?** **Recommendation: keep Notion as the operational front end
   now** — it's already your source of truth, has board views, zero new build,
   and adding a third surface re-creates the dual-tracker drift we already
   fought. Add the **CopilotKit + Next.js copilot** (yesterday's plan) as the
   Phase-2 UX once the daily run is reliable. I can also drop in a **read-only
   live Notion dashboard artifact** as an at-a-glance layer with no drift risk.
4. **Honest automatable %?** ~80% to ready-to-submit; ~15–30% true autonomous
   submission (ToS/safety-capped). See table above.

## "Hundreds of jobs we're missing daily"
Real, and mostly a *breadth* problem, not a submission problem. The scan was
running 5 narrow keywords. Widened today to include **AI Consultant, AI
Deployment Strategist, applied AI consultant, AI enablement lead, enterprise AI
advisor** + a contract track. That recovers most of the missed volume **without**
driving LinkedIn.com directly (which is the ban-risk path). Saved-search params
are replicated as scanner configs, not browser automation.

## What I'm accountable for delivering
- **This morning:** run the live multi-source scan with the widened keywords →
  score → stage the full *Materials Ready* batch (FTE + consulting) to Notion,
  cover letters drafted. Give you a one-screen approve list.
- **Submission:** Easy-Apply subset via the gated daemon on your go; everything
  else pre-filled for a fast human click-through. No silent auto-submits.
- **Evening + tomorrow AM:** repeat on schedule, report what actually got staged
  vs submitted vs blocked — with reasons, not excuses.
