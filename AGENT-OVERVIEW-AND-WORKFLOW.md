# Job Application Agent — Overview & Workflow

**Owner:** Sav Banerjee (sav@ensopartners.co)
**Last updated:** 2026-06-04

---

## 1. What this agent is

An automated job-application pipeline that **scans** sources for roles, **scores** them against Sav's profile, **generates** tailored resumes and cover letters for strong matches, and **submits** applications — with a **human-in-the-loop approval gate before every submission**.

The goal is income velocity: surface high-fit roles fast, produce ATS-clean materials automatically, and remove the manual busywork of applying — without ever submitting something Sav hasn't seen.

```
Sources ─▶ Score & Filter ─▶ Notion Command Center ─▶ Materials ─▶ Submit (human-gated)
```

---

## 2. The three agents

### Scanner Agent
Runs 3x daily on weekdays. Pulls roles from six sources:

1. **Work Gmail (MCP)** — LinkedIn, Indeed, recruiter alerts
2. **Career pages** — 8 target companies (Anthropic, OpenAI, DeepMind, Cuesta, McKinsey, BCG, Bain, Goldman)
3. **Personal Gmail (OAuth)** — `sav.banerjee@gmail.com`, catches recruiter mail the relay misses
4. **Substack RSS** — 6 curated VC/operator newsletters (founding-team roles)
5. **JobRight** — `eric@jobright.com` digests (personal inbox)
6. **Ladders** — `jobs@my.theladders.com` digests (work inbox)

Every role runs through **hard filters first** (salary + location — non-negotiable, auto-skip on fail), then `scoreRole()` (0–10): title match, skill overlap, industry fit, location, comp signal.

### Materials Agent
Auto-triggered on score 8+. Merges `candidate.json` + role-specific hooks into the master templates, generates tailored resume + cover letter in memory, converts to ATS-optimized `.docx` (Arial 11pt, single column, no graphics), and attaches them to the role's Notion page.

### Submitter Agent
**Manual trigger only — never auto-scheduled.** Fills platform-specific forms (Greenhouse, Ashby, Lever, Google Careers), logs the row as `Queued` before any click, and **stops for explicit approval before submitting**. Only Tier 1/2 Easy-Apply submissions are auto-confirmed without asking.

---

## 3. Scoring thresholds

| Score | Action |
|---|---|
| < 5 | Silent skip — not tracked |
| 5–6 | Tracked in Notion (passive) |
| 7+ | Priority / active monitoring |
| 8+ | Auto-generate materials |

---

## 4. Hard rules (always enforced)

- **Never auto-submit** without human approval (except sanctioned Tier 1/2 Easy Apply).
- **Never apply to Perplexity, BOI, or Sia Partners** — permanent exclusions.
- **Never fabricate** metrics or client names; use exact `candidate.json` figures. Gore = "Global Materials Manufacturer."
- **Auto-skip roles requiring a CS degree** (Sav has none — pull live JD to catch it).
- **Client projects are read-only** (Heller, Eligard, Rubraca, Eton) — never edit.
- **Stop on CAPTCHA / login walls** and ask.

---

## 5. What I'm tasked to do — my operating workflow

This is how I run the agent for Sav in each session:

1. **Scan** the active sources, applying hard filters *before* scoring. Skip anything that fails salary/location.
2. **Score** every surviving role with `scoreRole()` using the full job description (fetch the live JD — don't score off the email snippet).
3. **Triage** by threshold: archive < 8 in Notion and move on without prompting; advance 8+ to materials.
4. **Generate materials** for 8+ roles — tailored resume + cover letter, ATS-clean `.docx`, each cover letter citing at least one live `ensolabs.ai/work/*` URL.
5. **Stage submissions**, then **submit** only Tier 1/2 Easy-Apply automatically; everything else stops for Sav's approval with a screenshot.
6. **Dedup + log**: check Notion for existing Company + Title before writing; log every action; mark processed job emails as read.
7. **Brief Sav in-chat** (never by email) — lead with a visual/diagram, 1–3 lines, white-on-dark and colorblind-safe. Email briefings are off.
8. **Research when blocked** — unknown company or missing JD, I look it up myself rather than bouncing it back.
9. **Be decisive** — decide and act with my own tools; questions are rare.

**Batch limit:** max 7 submissions per session, then forced pause + summary.

---

## 6. Where things live

- **Primary tracker:** Notion Career Command Center (dedup, status, materials)
- **Archive:** Google Sheet + Drive (read-only, being retired)
- **Code:** `github.com/nycsav/job-application-agent` (public, MIT)
- **Profile:** `config/candidate.json` · **Roles:** `config/roles.json` · **Templates:** `templates/`
