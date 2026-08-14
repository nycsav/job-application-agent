#!/usr/bin/env node
/**
 * PreToolUse hook — HARD BLOCK on Submit/Apply clicks during a job application.
 *
 * This is a real, enforcing guardrail (unlike the prose matcher it replaces).
 * Claude Code pipes the tool call as JSON on stdin. We inspect the tool name +
 * input; if it's a browser/computer interaction whose target looks like a
 * Submit/Apply/Send control, we exit 2 — which Claude Code treats as a BLOCK
 * and surfaces the stderr message to the agent. Anything else exits 0 (allow).
 *
 * Why this works with the Anthropic Playwright MCP: browser_click includes a
 * human-readable `element` description (e.g. "Submit application button"),
 * so the dangerous control is visible in tool_input and we can catch it.
 *
 * Fail-OPEN only on parse errors of our own (never crash the session), but
 * fail-CLOSED (block) whenever the target matches a submit control.
 */

import { readFileSync } from 'fs';

let data = {};
try {
  data = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  process.exit(0); // couldn't parse our own stdin — don't wedge the session
}

const tool = String(data.tool_name || '').toLowerCase();
const input = JSON.stringify(data.tool_input || {}).toLowerCase();

// Only police tools that can actually click/submit in a browser or on screen.
const INTERACTS = /click|press|mouse|computer|browser|key|tap/;

// Target text that means "this sends the application."
const SUBMIT = /submit|apply now|apply for this|send application|finish (and|&) |complete application|"apply"|>\s*apply|application['" ]*submit/;

if (INTERACTS.test(tool) && SUBMIT.test(input)) {
  process.stderr.write(
    'SUBMISSION BLOCKED by block-submit hook.\n' +
    'This action targets a Submit/Apply/Send control on a job application form. ' +
    'STOP. Show Sav a screenshot of the filled form and get explicit "go" in chat ' +
    'before re-attempting. To proceed after approval, the human confirms — the agent ' +
    'does not bypass this on its own.\n'
  );
  process.exit(2); // 2 = block
}

process.exit(0); // allow
