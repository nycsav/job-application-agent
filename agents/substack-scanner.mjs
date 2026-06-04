#!/usr/bin/env node
/**
 * Substack Scanner Agent — Newsletter Job Discovery (Source 3)
 *
 * WHAT IT DOES:
 * 1. Fetches RSS feeds for the curated Substack list in config/substack-sources.json
 * 2. Filters posts within the scan window that contain hiring trigger phrases
 * 3. Extracts {company, title, apply_url, location} listings from the post HTML
 * 4. Reuses scoreRole() from agents/scanner.mjs — same 0-10 rubric, same thresholds
 * 5. Applies the same EXCLUDE_COMPANIES blacklist (Perplexity, BOI)
 * 6. Returns scored roles for the orchestrator to push into the Google Sheet
 *
 * INTEGRATION:
 *   - Called by orchestrator.mjs alongside the Gmail + career-page scanners
 *   - Output rows match the existing Jobs-tab schema (no sheet changes required)
 *   - Score 5+ → Jobs tab, 7+ → High Profile, 8+ → triggers Materials Agent
 *
 * NO AUTH REQUIRED — Substack RSS feeds are public.
 *
 * Usage:
 *   node agents/substack-scanner.mjs        # scan + log results
 *   import { scanSubstack } from './agents/substack-scanner.mjs'
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { scoreRole, EXCLUDE_COMPANIES, MINIMUM_SHEET_SCORE } from './scanner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CONFIG_PATH = join(ROOT, 'config', 'substack-sources.json');

const USER_AGENT = 'Mozilla/5.0 (compatible; SavJobAgent/1.0; +https://github.com/nycsav/job-application-agent)';

/* ───────────────────────────  RSS  ─────────────────────────── */

async function fetchFeed(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Feed ${url} returned ${res.status}`);
  return res.text();
}

/**
 * Tiny RSS 2.0 parser — extracts {title, link, pubDate, content} for each <item>.
 * Avoids adding a dependency; Substack feeds are well-formed RSS.
 */
function parseRss(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRe.exec(xml)) !== null) {
    const body = match[1];
    const get = (tag) => {
      const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\/${tag}>`);
      const m = body.match(re);
      if (!m) return '';
      return m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim();
    };
    items.push({
      title: get('title'),
      link: get('link'),
      pubDate: get('pubDate'),
      content: get('content:encoded') || get('description'),
    });
  }
  return items;
}

/* ─────────────────────────  Extraction  ───────────────────────── */

const TRIGGER_RE = /\b(is hiring|now hiring|are hiring|hiring a|hiring an|open roles|apply here|apply to join)\b/i;

/**
 * Pull job listings out of a post's HTML body. Substack posts list roles as
 * bullet items: each <li> typically contains a company link, a role title,
 * and an apply-here link. We greedy-extract every <li> that mentions hiring.
 */
function extractListings(post, allowDomains) {
  const listings = [];
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
  let match;
  while ((match = liRe.exec(post.content)) !== null) {
    const li = match[1];
    const text = stripTags(li);
    if (!TRIGGER_RE.test(text)) continue;

    const links = [...li.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
      .map(m => ({ href: m[1], label: stripTags(m[2]).trim() }))
      .filter(l => l.href.startsWith('http'));

    const applyLink = links.find(l =>
      allowDomains.some(d => l.href.includes(d)) ||
      /apply/i.test(l.label)
    );
    if (!applyLink) continue;

    const company = guessCompany(li, links);
    const title = guessTitle(text, li);
    const location = guessLocation(text);

    listings.push({
      company,
      title,
      location,
      apply_url: applyLink.href,
      description: text.slice(0, 1200),
      source: 'substack',
      source_post: post.link,
      source_publication: post._publication,
      discovered_at: new Date().toISOString(),
    });
  }
  return listings;
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function guessCompany(li, links) {
  // Prefer a link whose URL itself names the company (careers.<co>.com, jobs.ashbyhq.com/<co>).
  // This is more reliable than label-based guessing, which often picks a person's name.
  for (const l of links) {
    const m = l.href.match(/(?:jobs|careers|boards|job-boards)[.\/]([a-z0-9-]+)/i);
    if (m && !/apply|here|view/i.test(m[1])) {
      // Skip ATS host names themselves.
      if (!['ashbyhq', 'greenhouse', 'lever', 'withwaymo'].includes(m[1].toLowerCase())) {
        return titleCase(m[1].replace(/-/g, ' '));
      }
    }
  }
  // Fallback: first non-Apply link with proper-cased label.
  const candidate = links.find(l =>
    !/apply|here|DM/i.test(l.label) &&
    /^[A-Z]/.test(l.label) &&
    l.label.length > 1 && l.label.length < 60
  );
  return candidate ? candidate.label.replace(/\s+\(.+\)$/, '').trim() : 'Unknown';
}

function titleCase(s) {
  return s.replace(/\b\w/g, c => c.toUpperCase());
}

function guessTitle(text, li) {
  // Pattern: "hiring a [Title] in" or "hiring an [Title]". Greedy up to comma/period.
  const m = text.match(/hiring an? ([^,.()!?]+?)(?:\s+(?:in|for|at|to|—|-|\(|$))/i);
  if (m) return m[1].trim();
  // Fallback: first bolded or linked phrase after "hiring"
  const fallback = text.match(/hiring[^a-z]+([A-Z][^,.]{4,80})/);
  return fallback ? fallback[1].trim() : 'Untitled role';
}

function guessLocation(text) {
  const m = text.match(/\b(in|based in)\s+(SF|NYC|New York|San Francisco|Brooklyn|Remote|Stockholm|London|Boston|Seattle|Mountain View|Manhattan|Presidio)\b/i);
  return m ? m[2] : '';
}

/* ───────────────────────  Main entry point  ─────────────────────── */

export async function scanSubstack({ now = new Date() } = {}) {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  const windowMs = cfg.scan_window_hours * 3600 * 1000;
  const cutoff = now.getTime() - windowMs;
  const allowDomains = cfg.extraction_hints.url_allowlist_domains;

  const allListings = [];
  const errors = [];

  for (const feed of cfg.feeds) {
    if (feed.disabled) continue;
    try {
      const xml = await fetchFeed(feed.url);
      const posts = parseRss(xml)
        .slice(0, cfg.max_posts_per_feed)
        .filter(p => {
          const ts = Date.parse(p.pubDate);
          return Number.isFinite(ts) && ts >= cutoff;
        })
        .filter(p => TRIGGER_RE.test(p.content));

      for (const p of posts) {
        p._publication = feed.name;
        const listings = extractListings(p, allowDomains);
        // Per-feed minimum-score override allows secondary feeds to be stricter.
        for (const role of listings) {
          role._feed_min_score = feed.min_score_to_track || MINIMUM_SHEET_SCORE;
          allListings.push(role);
        }
      }
    } catch (err) {
      errors.push({ feed: feed.name, error: err.message });
    }
  }

  // Score everything, drop blacklist hits, drop sub-threshold rows.
  const scored = allListings
    .filter(r => !EXCLUDE_COMPANIES.some(b => r.company.toLowerCase().includes(b.toLowerCase())))
    .map(r => {
      const s = scoreRole(r);
      return { ...r, score: s.score, score_breakdown: s.breakdown, matched_skills: s.matchedSkills };
    })
    .filter(r => r.score >= r._feed_min_score)
    .sort((a, b) => b.score - a.score);

  return {
    summary: {
      feeds_scanned: cfg.feeds.length,
      posts_with_jobs: new Set(scored.map(r => r.source_post)).size,
      total_listings: allListings.length,
      kept_after_scoring: scored.length,
      errors,
    },
    listings: scored,
  };
}

/* ────────────────────────────  CLI  ──────────────────────────── */

if (import.meta.url === `file://${process.argv[1]}`) {
  scanSubstack()
    .then(({ summary, listings }) => {
      console.log('Scan summary:', JSON.stringify(summary, null, 2));
      console.log(`\nTop ${Math.min(10, listings.length)} scored roles:`);
      for (const r of listings.slice(0, 10)) {
        console.log(`  [${r.score}] ${r.company} — ${r.title} (${r.location || 'loc?'}) → ${r.apply_url}`);
      }
    })
    .catch(err => {
      console.error('Scanner failed:', err);
      process.exit(1);
    });
}
