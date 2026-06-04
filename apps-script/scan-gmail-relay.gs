/**
 * Gmail Relay — scan_gmail + clean_confirmations actions for doPost endpoint
 *
 * PURPOSE:
 *   1. scan_gmail        — reads job alert emails from sav.banerjee@gmail.com
 *                          (bypasses the work Gmail MCP connector)
 *   2. clean_confirmations — labels + archives "your application was sent"
 *                            confirmation emails to keep inbox clean
 *
 * USAGE:
 *   scan_gmail:
 *     {"action": "scan_gmail"}                          — default 8 queries, 12h
 *     {"action": "scan_gmail", "hours": 24}             — custom time window
 *     {"action": "scan_gmail", "queries": ["custom"]}   — custom queries
 *     {"action": "scan_gmail", "hours": 24, "max_threads": 30}
 *
 *   clean_confirmations:
 *     {"action": "clean_confirmations"}                 — default 48h, live mode
 *     {"action": "clean_confirmations", "hours": 168}   — last 7 days
 *     {"action": "clean_confirmations", "dry_run": true} — preview only, no writes
 *
 * RETURNS: JSON with stats + processed thread data.
 *
 * ADD TO EXISTING doPost: Add these cases to the switch statement:
 *   case 'scan_gmail':          return handleScanGmail_(payload);
 *   case 'clean_confirmations': return handleCleanConfirmations_(payload);
 */

// ─── Default Job Alert Queries ─────────────────────────────────
// These match the 8 queries in the scheduled task SKILL.md prompts.
// The `newer_than` param is injected dynamically based on `hours`.

const DEFAULT_JOB_QUERIES = [
  'subject:(VP AI OR Director AI OR Head of AI OR Chief AI Officer)',
  'from:linkedin.com subject:(VP OR Director OR Head) subject:(AI OR artificial intelligence)',
  'subject:(Solutions Architect AI OR AI Architect OR Principal AI Engineer OR Applied AI)',
  'from:linkedin.com subject:(architect OR engineer OR principal) subject:(AI OR ML OR LLM)',
  'subject:(Partner Director AI OR Alliance Manager OR BD AI OR Strategic Partnerships AI)',
  'subject:(AI Strategy Consultant OR AI Advisory OR Strategy Director AI OR Management Consulting AI)',
  'from:(recruiter OR talent OR hiring) subject:(AI OR artificial intelligence OR opportunity)',
  'from:indeed.com subject:(job OR alert OR recommendation) subject:(AI OR strategy OR director OR VP)'
];

// ─── Main Handler ──────────────────────────────────────────────

function handleScanGmail_(payload) {
  try {
    const hours = Math.min(payload.hours || 12, 168); // Cap at 168h (was 72h)
    const maxThreads = Math.min(payload.max_threads || 50, 100); // Cap at 100
    const queries = payload.queries || DEFAULT_JOB_QUERIES;
    const timeFilter = 'newer_than:' + hours + 'h';

    const allThreads = [];
    const seenThreadIds = new Set();
    const queryStats = [];

    for (let i = 0; i < queries.length; i++) {
      const fullQuery = queries[i] + ' ' + timeFilter;

      let threads = [];
      try {
        threads = GmailApp.search(fullQuery, 0, 20); // Max 20 per query
      } catch (searchErr) {
        queryStats.push({
          query_index: i,
          query: queries[i],
          found: 0,
          error: searchErr.message
        });
        continue;
      }

      let addedFromQuery = 0;

      for (let t = 0; t < threads.length; t++) {
        if (allThreads.length >= maxThreads) break;

        const thread = threads[t];
        const threadId = thread.getId();

        // Deduplicate across queries
        if (seenThreadIds.has(threadId)) continue;
        seenThreadIds.add(threadId);

        const extracted = extractThreadData_(thread, i);
        if (extracted) {
          allThreads.push(extracted);
          addedFromQuery++;
        }
      }

      queryStats.push({
        query_index: i,
        query: queries[i],
        found: threads.length,
        added: addedFromQuery,
        deduplicated: threads.length - addedFromQuery
      });
    }

    return jsonResponse_({
      success: true,
      source: 'personal_gmail_relay',
      account: Session.getActiveUser().getEmail(),
      scan_window_hours: hours,
      total_threads: allThreads.length,
      query_stats: queryStats,
      threads: allThreads
    });

  } catch (err) {
    return jsonResponse_({
      success: false,
      error: err.message,
      source: 'personal_gmail_relay'
    }, 500);
  }
}

// ─── Thread Extraction ─────────────────────────────────────────

function extractThreadData_(thread, queryIndex) {
  try {
    const messages = thread.getMessages();
    if (!messages || messages.length === 0) return null;

    // Use the most recent message in the thread
    const latestMsg = messages[messages.length - 1];
    const firstMsg = messages[0];

    // Extract all unique senders
    const senders = [];
    const senderSet = new Set();
    for (let m = 0; m < messages.length; m++) {
      const from = messages[m].getFrom();
      if (!senderSet.has(from)) {
        senderSet.add(from);
        senders.push(from);
      }
    }

    // Determine source based on sender
    const senderLower = firstMsg.getFrom().toLowerCase();
    let source = 'Other';
    if (senderLower.includes('linkedin.com')) source = 'LinkedIn Alert';
    else if (senderLower.includes('indeed.com')) source = 'Indeed Alert';
    else if (senderLower.includes('dice.com')) source = 'Dice Alert';
    else if (senderLower.includes('ziprecruiter')) source = 'ZipRecruiter Alert';
    else if (senderLower.includes('recruiter') || senderLower.includes('talent') || senderLower.includes('hiring')) source = 'Recruiter Email';

    // Get plain text body (truncated to save response size)
    let body = '';
    try {
      body = latestMsg.getPlainBody() || '';
      if (body.length > 8000) {
        body = body.substring(0, 8000) + '\n[TRUNCATED]';
      }
    } catch (bodyErr) {
      body = '[Could not extract body]';
    }

    // Extract URLs from the body
    const urls = extractUrls_(body);

    return {
      thread_id: thread.getId(),
      message_id: latestMsg.getId(),
      subject: firstMsg.getSubject() || '(no subject)',
      from: firstMsg.getFrom(),
      to: firstMsg.getTo(),
      date: latestMsg.getDate().toISOString(),
      message_count: messages.length,
      snippet: body.substring(0, 500),
      body: body,
      labels: thread.getLabels().map(function(l) { return l.getName(); }),
      source: source,
      query_index: queryIndex,
      urls: urls,
      is_unread: thread.isUnread(),
      has_attachments: latestMsg.getAttachments().length > 0
    };
  } catch (err) {
    return {
      thread_id: thread.getId(),
      error: 'Extraction failed: ' + err.message,
      subject: '(error)',
      query_index: queryIndex
    };
  }
}

// ─── URL Extraction ────────────────────────────────────────────

function extractUrls_(text) {
  if (!text) return [];
  var urlRegex = /https?:\/\/[^\s<>"')\]]+/g;
  var matches = text.match(urlRegex) || [];

  // Filter to likely job URLs and deduplicate
  var seen = {};
  var filtered = [];
  for (var i = 0; i < matches.length; i++) {
    var url = matches[i];
    // Skip tracking pixels, unsubscribe links, etc.
    // NOTE: Don't match bare 'tracking' — LinkedIn apply URLs include ?trackingId=... which is legit.
    // Only match true tracking endpoints (with path separators) and tracking redirect domains.
    if (url.includes('unsubscribe') || url.includes('beacon') ||
        url.includes('/tracking/') || url.includes('/track/') ||
        url.includes('pixel.gif') || url.includes('tracker.') ||
        url.includes('click.') || url.length > 2000) continue;
    if (!seen[url]) {
      seen[url] = true;
      filtered.push(url);
    }
    if (filtered.length >= 10) break; // Cap at 10 URLs
  }
  return filtered;
}

// ─── Confirmation Cleanup ──────────────────────────────────────
// Labels + archives "your application was sent" confirmation emails
// to keep the inbox clean. Nested label: "Automation Job/Confirmations"

const CONFIRMATION_LABEL = 'Automation Job/Confirmations';

const CONFIRMATION_QUERIES = [
  'subject:("Your application" OR "application was sent" OR "we received your application" OR "thank you for applying" OR "application received" OR "thanks for applying" OR "application submitted")',
  'from:linkedin.com subject:(application)',
  'from:(greenhouse-mail.io OR no-reply@greenhouse.io OR notifications@greenhouse.io)',
  'from:(lever.co OR no-reply@lever.co OR hello@lever.co)',
  'from:(smartrecruiters.com)',
  'from:(ashbyhq.com OR notifications@ashbyhq.com)',
  'from:(myworkday.com OR workdayjobs.com)',
  'from:(taleo.net OR oraclecloud.com) subject:(application OR applied)'
];

function handleCleanConfirmations_(payload) {
  try {
    const hours = Math.min(payload.hours || 48, 720); // Default 48h, cap 30d
    const dryRun = payload.dry_run === true;
    const timeFilter = 'newer_than:' + hours + 'h';

    // Get or create the nested label
    let label = GmailApp.getUserLabelByName(CONFIRMATION_LABEL);
    if (!label && !dryRun) {
      label = GmailApp.createLabel(CONFIRMATION_LABEL);
    }

    const seenThreadIds = {};
    const processed = [];
    const queryStats = [];

    for (let i = 0; i < CONFIRMATION_QUERIES.length; i++) {
      // Only target threads still in inbox to avoid re-archiving
      const fullQuery = CONFIRMATION_QUERIES[i] + ' in:inbox ' + timeFilter;

      let threads = [];
      try {
        threads = GmailApp.search(fullQuery, 0, 50);
      } catch (searchErr) {
        queryStats.push({
          query_index: i,
          query: CONFIRMATION_QUERIES[i],
          error: searchErr.message
        });
        continue;
      }

      let archived = 0;
      for (let t = 0; t < threads.length; t++) {
        const thread = threads[t];
        const tid = thread.getId();
        if (seenThreadIds[tid]) continue;
        seenThreadIds[tid] = true;

        if (!dryRun) {
          if (label) thread.addLabel(label);
          thread.moveToArchive();
        }

        processed.push({
          thread_id: tid,
          subject: thread.getFirstMessageSubject() || '(no subject)',
          from: thread.getMessages()[0].getFrom(),
          date: thread.getLastMessageDate().toISOString(),
          query_index: i
        });
        archived++;
      }

      queryStats.push({
        query_index: i,
        query: CONFIRMATION_QUERIES[i],
        found: threads.length,
        archived: archived
      });
    }

    return jsonResponse_({
      success: true,
      action: 'clean_confirmations',
      account: Session.getActiveUser().getEmail(),
      label: CONFIRMATION_LABEL,
      label_existed: GmailApp.getUserLabelByName(CONFIRMATION_LABEL) !== null,
      dry_run: dryRun,
      scan_window_hours: hours,
      total_archived: processed.length,
      query_stats: queryStats,
      threads: processed
    });

  } catch (err) {
    return jsonResponse_({
      success: false,
      error: err.message,
      action: 'clean_confirmations'
    }, 500);
  }
}

// ─── Health Checks ─────────────────────────────────────────────
// Run these in the Apps Script editor to verify access

function testScanGmail() {
  const result = handleScanGmail_({ hours: 24 });
  const data = JSON.parse(result.getContent());
  Logger.log('Account: ' + data.account);
  Logger.log('Threads found: ' + data.total_threads);
  Logger.log('Query stats: ' + JSON.stringify(data.query_stats, null, 2));
  if (data.threads && data.threads.length > 0) {
    Logger.log('First thread: ' + data.threads[0].subject);
  }
}

function testCleanConfirmations() {
  // Dry-run preview — does not modify any threads
  const result = handleCleanConfirmations_({ hours: 168, dry_run: true });
  const data = JSON.parse(result.getContent());
  Logger.log('Account: ' + data.account);
  Logger.log('Label: ' + data.label + ' (exists: ' + data.label_existed + ')');
  Logger.log('Would archive: ' + data.total_archived);
  Logger.log('Query stats: ' + JSON.stringify(data.query_stats, null, 2));
}
