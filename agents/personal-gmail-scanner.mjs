#!/usr/bin/env node
/**
 * Personal Gmail Scanner — Direct Gmail API scanner for sav.banerjee@gmail.com
 *
 * Replaces the dead Composio-based "gmail-personal" MCP.
 * Uses Google OAuth2 refresh token (set up via lib/gmail-auth.mjs).
 *
 * WHAT IT DOES:
 * 1. Authenticates to sav.banerjee@gmail.com via saved OAuth2 token
 * 2. Searches for job alert emails (LinkedIn, Indeed, recruiter outreach)
 * 3. Extracts role details from email bodies
 * 4. Scores each role using scoreRole() from scanner.mjs
 * 5. Outputs structured JSON for the pipeline to push to Notion
 *
 * USAGE:
 *   node agents/personal-gmail-scanner.mjs                    # scan last 8h
 *   node agents/personal-gmail-scanner.mjs --hours 24         # scan last 24h
 *   node agents/personal-gmail-scanner.mjs --from "Jack"      # scan from specific sender
 *   node agents/personal-gmail-scanner.mjs --query "subject:(AI director)"  # custom query
 *
 * OUTPUT: JSON array of scored roles to stdout. Pipeline reads this.
 */

import { getGmailClient } from '../lib/gmail-auth.mjs';
import { scoreRole, EXCLUDE_COMPANIES, MINIMUM_SHEET_SCORE } from './scanner.mjs';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ─── Configuration ──────────────────────────────────────────────

const DEFAULT_HOURS = 8;

// Same cluster-aligned queries as daily-scan.md, adapted for Gmail API search
const SEARCH_CLUSTERS = [
  {
    name: 'ai_transformation',
    queries: [
      'subject:(VP AI OR Director AI OR Head of AI OR Chief AI Officer OR AI transformation OR enterprise AI strategy)',
      'from:linkedin.com subject:(VP OR Director OR Head) subject:(AI OR artificial intelligence)',
    ],
  },
  {
    name: 'ai_architecture',
    queries: [
      'subject:(Solutions Architect AI OR AI Architect OR Principal AI Engineer OR Applied AI OR agentic systems OR Claude OR LLM)',
      'from:linkedin.com subject:(architect OR engineer OR principal) subject:(AI OR ML OR LLM)',
    ],
  },
  {
    name: 'ai_partnerships',
    queries: [
      'subject:(Partner Director AI OR Alliance Manager OR BD AI OR Strategic Partnerships AI OR ecosystem)',
      'from:linkedin.com subject:(partner OR alliance OR business development) subject:(AI)',
    ],
  },
  {
    name: 'ai_strategy_consulting',
    queries: [
      'subject:(AI Strategy Consultant OR AI Advisory OR Strategy Director AI OR Management Consulting AI OR AI consulting)',
      'from:linkedin.com subject:(consultant OR advisory OR strategy) subject:(AI OR digital)',
    ],
  },
  {
    name: 'recruiter_outreach',
    queries: [
      'from:(recruiter OR talent OR hiring OR staffing) subject:(AI OR artificial intelligence OR opportunity OR role)',
      'from:indeed.com subject:(job OR alert OR recommendation) subject:(AI OR strategy OR director OR VP)',
    ],
  },
];

// ─── CLI Arg Parsing ────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { hours: DEFAULT_HOURS, from: null, query: null, verbose: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--hours' && args[i + 1]) { opts.hours = parseInt(args[i + 1]); i++; }
    else if (args[i] === '--from' && args[i + 1]) { opts.from = args[i + 1]; i++; }
    else if (args[i] === '--query' && args[i + 1]) { opts.query = args[i + 1]; i++; }
    else if (args[i] === '--verbose' || args[i] === '-v') { opts.verbose = true; }
  }
  return opts;
}

// ─── Email Parsing ──────────────────────────────────────────────

function decodeBase64Url(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function getHeader(headers, name) {
  const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function extractBody(payload) {
  // Try direct body
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  // Try parts (multipart)
  if (payload.parts) {
    // Prefer text/plain, fall back to text/html
    const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
    if (textPart?.body?.data) return decodeBase64Url(textPart.body.data);

    const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      const html = decodeBase64Url(htmlPart.body.data);
      return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    // Nested multipart
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }
  return '';
}

/**
 * Extract job role details from email body text.
 * Handles LinkedIn alert emails, Indeed digests, and recruiter emails.
 */
function extractRolesFromEmail(subject, body, from, date) {
  const roles = [];

  // LinkedIn job alert pattern: "Job Title at Company"
  const linkedinPattern = /(?:^|\n)\s*([A-Z][^–\n]{5,60})\s+at\s+([A-Z][^\n]{2,40})/gm;
  let match;
  while ((match = linkedinPattern.exec(body)) !== null) {
    roles.push({
      title: match[1].trim(),
      company: match[2].trim(),
      source: 'LinkedIn Alert',
      source_email: from,
      date,
    });
  }

  // Indeed pattern: "Title\nCompany - Location"
  const indeedPattern = /(?:^|\n)\s*([A-Z][^\n]{5,60})\n\s*([A-Z][^\n-]{2,40})\s*-\s*([^\n]+)/gm;
  while ((match = indeedPattern.exec(body)) !== null) {
    roles.push({
      title: match[1].trim(),
      company: match[2].trim(),
      location: match[3].trim(),
      source: 'Indeed Alert',
      source_email: from,
      date,
    });
  }

  // If no structured matches, treat the whole email as a single role pitch (recruiter email)
  if (roles.length === 0 && body.length > 50) {
    // Try to extract title from subject
    const titleMatch = subject.match(/(?:opportunity|role|position|opening):\s*(.+)/i)
      || subject.match(/(.+?)(?:\s+at\s+|\s+-\s+)/i);
    const companyMatch = body.match(/(?:at|with|for)\s+([A-Z][A-Za-z0-9\s&.]+?)(?:\.|,|\s+is|\s+are|\s+has)/);

    if (titleMatch || companyMatch) {
      roles.push({
        title: titleMatch ? titleMatch[1].trim() : subject.slice(0, 60),
        company: companyMatch ? companyMatch[1].trim() : 'Unknown',
        description: body.slice(0, 500),
        source: 'Recruiter Email',
        source_email: from,
        date,
      });
    }
  }

  // Enrich with location from body if missing
  for (const role of roles) {
    if (!role.location) {
      const locMatch = body.match(/(?:location|based in|office in|located in)[:\s]+([^\n,]{3,40})/i);
      if (locMatch) role.location = locMatch[1].trim();
    }
    // Grab description snippet if missing
    if (!role.description) {
      const idx = body.toLowerCase().indexOf(role.title.toLowerCase());
      if (idx >= 0) {
        role.description = body.slice(idx, idx + 500).trim();
      }
    }
  }

  return roles;
}

// ─── Main Scanner ───────────────────────────────────────────────

async function scan(opts) {
  const gmail = await getGmailClient();
  const timeFilter = `newer_than:${opts.hours}h`;
  const seenMessageIds = new Set();
  const allRoles = [];

  // Build query list
  let queries;
  if (opts.query) {
    // Custom query mode
    queries = [{ name: 'custom', queries: [`${opts.query} ${timeFilter}`] }];
  } else if (opts.from) {
    // Sender-specific mode
    queries = [{ name: 'sender_search', queries: [`from:${opts.from} ${timeFilter}`] }];
  } else {
    // Default: all clusters
    queries = SEARCH_CLUSTERS.map(c => ({
      name: c.name,
      queries: c.queries.map(q => `${q} ${timeFilter}`),
    }));
  }

  for (const cluster of queries) {
    for (const query of cluster.queries) {
      if (opts.verbose) console.error(`[${cluster.name}] Searching: ${query}`);

      try {
        const res = await gmail.users.messages.list({
          userId: 'me',
          q: query,
          maxResults: 50,
        });

        const messages = res.data.messages || [];
        if (opts.verbose) console.error(`  → ${messages.length} messages`);

        for (const msg of messages) {
          if (seenMessageIds.has(msg.id)) continue;
          seenMessageIds.add(msg.id);

          const full = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'full',
          });

          const headers = full.data.payload.headers;
          const subject = getHeader(headers, 'Subject');
          const from = getHeader(headers, 'From');
          const date = getHeader(headers, 'Date');
          const body = extractBody(full.data.payload);

          const roles = extractRolesFromEmail(subject, body, from, date);

          for (const role of roles) {
            // Exclusion check
            if (EXCLUDE_COMPANIES.some(ex => (role.company || '').toLowerCase().includes(ex.toLowerCase()))) {
              if (opts.verbose) console.error(`  ✗ Excluded: ${role.company}`);
              continue;
            }

            role.cluster = cluster.name;
            role.gmail_message_id = msg.id;
            role.gmail_thread_id = msg.threadId;

            // Score it
            const { score, breakdown, matchedSkills } = scoreRole(role);
            role.score = score;
            role.score_breakdown = breakdown;
            role.matched_skills = matchedSkills;

            if (score >= MINIMUM_SHEET_SCORE) {
              allRoles.push(role);
            } else if (opts.verbose) {
              console.error(`  ✗ Low score (${score}): ${role.title} at ${role.company}`);
            }
          }
        }
      } catch (err) {
        console.error(`[${cluster.name}] Error: ${err.message}`);
      }
    }
  }

  // Dedup by company + title
  const dedupKey = (r) => `${(r.company || '').toLowerCase()}|${(r.title || '').toLowerCase()}`;
  const seen = new Set();
  const unique = allRoles.filter(r => {
    const key = dedupKey(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by score descending
  unique.sort((a, b) => b.score - a.score);

  return unique;
}

// ─── Entry Point ────────────────────────────────────────────────

const opts = parseArgs();

scan(opts).then(roles => {
  // JSON to stdout for pipeline consumption
  console.log(JSON.stringify(roles, null, 2));

  // Summary to stderr
  console.error(`\n━━━ Personal Gmail Scan Complete ━━━`);
  console.error(`Account: sav.banerjee@gmail.com`);
  console.error(`Time window: last ${opts.hours} hours`);
  console.error(`Roles found (score ≥ ${MINIMUM_SHEET_SCORE}): ${roles.length}`);
  if (roles.length > 0) {
    console.error(`Top role: ${roles[0].title} at ${roles[0].company} (score: ${roles[0].score})`);
    const urgent = roles.filter(r => r.score >= 8);
    if (urgent.length) console.error(`🔥 Score 8+ (auto-materials): ${urgent.length} roles`);
  }
}).catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
