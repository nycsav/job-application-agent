# Agent Manager Structure + Success Measurement

Grounded in Anthropic's orchestrator-workers pattern ("Building Effective Agents" +
the multi-agent research system). No theater — only what's real and applicable here.

## 1. Manager (orchestrator) + workers

```
              ┌────────────────────────────┐
              │   MANAGER (lead agent)     │  owns pipeline state in Notion
              │   plan · delegate · verify │  + the human gate + audit trail
              └─────┬───────┬───────┬──────┘
        ┌───────────┘       │       └───────────┐
   ┌────▼────┐         ┌────▼────┐         ┌────▼────┐
   │ Scanner │ (×N)    │ Scorer  │         │ Tailor  │   parallel workers
   │ Gmail/  │         │ rubric  │         │ resume+ │
   │Indeed/  │         │ +dedup  │         │ letter  │
   │Dice...  │         └─────────┘         └─────────┘
   └─────────┘
```

**Manager's job is to PREVENT FAILURES**, via an acceptance check on every worker output:
- Scanner → returns ≥0 valid roles with {company,title,url}? else retry/flag.
- Scorer → score in [0,10] + dedup key checked against existing? else hold.
- Tailor → resume file resolves on disk + metrics verbatim from candidate.json? else block.
- Submit → **human gate** (irreversible); never bypassed.
Plus: idempotency (shared `dedupeKey`), retry-with-backoff on MCP drops (frequent),
circuit-breaker (halt + escalate after N failures), and one owner of Notion writes.

## 2. Observability (already partly live)
- **Per-row:** `Agent Trail` on every write — who/when/why. Target: 100% of writes.
- **Per-run:** structured log — scanned / scored / deduped / staged / errors / MTTR.
- **Traceable decisions:** every archive/approve carries a rationale (see the 3 dedup archives).

## 3. Prompt caching best practices (concrete to this system)
Reused, stable context = cache it once per run; vary only the role:
- **Cache prefix (stable):** system prompt + tool defs + `candidate.json` profile +
  `resume_map.json` + scoring rubric. Mark the cache breakpoint after this block.
- **Variable suffix:** the specific role JD/title — appended last.
- Prefix must be byte-identical to hit; keep TTL within the batch window (~5 min, or 1h extended).
- Payoff: scoring/tailoring N roles reuses the big profile+rubric prefix → lower cost + latency.

## 4. Reverse-engineered success metrics
Split what the **machine controls** from what the **market controls** (don't conflate).

**Process KPIs (own these — "did the agent do its job"):**
| Metric | Definition | Target |
|---|---|---|
| Click-ready rate | % strong roles reaching verified-link + resume-picked same day | ≥90% |
| Dedup accuracy | dups caught without killing distinct roles | proven 4/4 on real data |
| Audit completeness | % writes with an Agent Trail | 100% |
| Recovery | mean-time-to-recover from connector failure | < 1 retry cycle |
| Scoring agreement | agent score vs human spot-check | ≥80% within ±1 |

**Outcome KPIs (market-controlled — measure, never promise):**
Apply→Interview rate, Interview→Offer rate. Requires the outcome fields
(Applied→Interview→Offer→Rejected + dates) — the feedback-loop data. Build now, learn later.

## 5. Honest self-assessment of THIS session (measuring my own success)
- **Delivered:** discovery→score→dedup→stage pipeline; dedup fix (4/4); cleanup (3 archived);
  recovered profile + resumes; 5 modules + enforcing hook shipped; Lane A clarity; 3 click-ready roles.
- **Cost / failures:** spent too long on the auto-submit mirage before naming it; shipped a
  decorative hook first (caught by the local agent); couldn't push to the Worker repo (scope).
- **The one true success measure:** did Sav get closer to applying to good roles with less effort?
  Partially — 3 are click-ready — but the multi-round local setup loop was expensive. The fix is
  this manager structure: validate-before-pass so loops end in one round, not five.
