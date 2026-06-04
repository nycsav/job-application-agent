/**
 * Apps Script Web App — doPost endpoint for Job Application Agent
 *
 * Accepts JSON POST requests to append/update rows in the Job Tracker sheet.
 * Deploy as Web App (Execute as: Me, Access: Anyone) to get a URL the pipeline can call.
 *
 * SETUP:
 * 1. Open: https://script.google.com/u/2/home/projects/1saSsIzHuqNocF0BoGGeBC0qJnMlq3IWlSxJVoawDi6ARkZPlkZmuB-B_/edit
 * 2. Paste this code into a new file (or append to Code.gs)
 * 3. Deploy > New deployment > Web app > Execute as: Me > Access: Anyone
 * 4. Copy the deployment URL and paste it into config/pipeline.json as "sheets_webhook_url"
 */

const SHEET_ID = '1Wd0x_0fEAyScgMKB9neneuMIo3Sgln-CMytWMF8m6eI';
const JOBS_TAB = 'High Profile';

// Column order must match sheet headers
const COLUMN_ORDER = [
  'priority', 'date_found', 'fit_score', 'urgent', 'job_title', 'company',
  'location', 'salary_range', 'fit_reason', 'job_url', 'source',
  'portfolio_links', 'resume_link', 'cover_letter_link', 'form_url',
  'prefill_status', 'outreach_status', 'status', 'applied_date', 'response', 'notes'
];

/**
 * Handle POST requests from the pipeline
 *
 * Actions:
 *   append_row   — Add a new row to the sheet
 *   update_row   — Update an existing row by company+title match
 *   check_duplicate — Check if company+title already exists
 *   read_rows    — Return all rows (for dedup checks)
 */
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const action = payload.action;

    // Simple auth token check (optional — set in pipeline.json)
    if (payload.token && payload.token !== getScriptProperty_('PIPELINE_TOKEN')) {
      return jsonResponse_({ error: 'Invalid token' }, 403);
    }

    switch (action) {
      case 'append_row':
        return handleAppendRow_(payload.row);
      case 'update_row':
        return handleUpdateRow_(payload.match, payload.updates);
      case 'check_duplicate':
        return handleCheckDuplicate_(payload.company, payload.title);
      case 'read_rows':
        return handleReadRows_();
      default:
        return jsonResponse_({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    return jsonResponse_({ error: err.message }, 500);
  }
}

// Also handle GET for health checks
function doGet(e) {
  return jsonResponse_({ status: 'ok', sheet_id: SHEET_ID, tab: JOBS_TAB });
}

// ─── Handlers ───────────────────────────────────────────────────

function handleAppendRow_(rowData) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(JOBS_TAB);
  if (!sheet) return jsonResponse_({ error: `Tab "${JOBS_TAB}" not found` }, 404);

  // Check for duplicate first
  const existing = findRow_(sheet, rowData.company, rowData.job_title);
  if (existing) {
    return jsonResponse_({
      error: 'DUPLICATE_BLOCKED',
      message: `"${rowData.job_title}" at ${rowData.company} already exists at row ${existing.row}`,
      existing_status: existing.data.status
    }, 409);
  }

  // Build row array in column order
  const rowArray = COLUMN_ORDER.map(col => rowData[col] || '');
  sheet.appendRow(rowArray);

  return jsonResponse_({
    success: true,
    message: `Appended row for "${rowData.job_title}" at ${rowData.company}`,
    row_number: sheet.getLastRow()
  });
}

function handleUpdateRow_(match, updates) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(JOBS_TAB);
  if (!sheet) return jsonResponse_({ error: `Tab "${JOBS_TAB}" not found` }, 404);

  const found = findRow_(sheet, match.company, match.title);
  if (!found) {
    return jsonResponse_({ error: `No row found for "${match.title}" at ${match.company}` }, 404);
  }

  // Update specific columns
  const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  for (const [key, value] of Object.entries(updates)) {
    const colIndex = headerRow.findIndex(h =>
      h.toString().toLowerCase().replace(/\s+/g, '_') === key.toLowerCase()
    );
    if (colIndex >= 0) {
      // Handle notes_append specially — concatenate instead of replace
      if (key === 'notes_append') {
        const currentNotes = sheet.getRange(found.row, colIndex + 1).getValue();
        sheet.getRange(found.row, colIndex + 1).setValue(currentNotes + value);
      } else {
        sheet.getRange(found.row, colIndex + 1).setValue(value);
      }
    }
  }

  return jsonResponse_({
    success: true,
    message: `Updated row ${found.row} for "${match.title}" at ${match.company}`,
    updated_fields: Object.keys(updates)
  });
}

function handleCheckDuplicate_(company, title) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(JOBS_TAB);
  if (!sheet) return jsonResponse_({ error: `Tab "${JOBS_TAB}" not found` }, 404);

  const found = findRow_(sheet, company, title);
  return jsonResponse_({
    is_duplicate: !!found,
    row: found ? found.row : null,
    status: found ? found.data.status : null
  });
}

function handleReadRows_() {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(JOBS_TAB);
  if (!sheet) return jsonResponse_({ error: `Tab "${JOBS_TAB}" not found` }, 404);

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return jsonResponse_({ rows: [], count: 0 });

  const headers = data[0].map(h => h.toString().toLowerCase().replace(/\s+/g, '_'));
  const rows = data.slice(1).map((row, i) => {
    const obj = {};
    headers.forEach((h, j) => obj[h] = row[j]);
    obj._row_number = i + 2;
    return obj;
  });

  return jsonResponse_({ rows, count: rows.length });
}

// ─── Helpers ────────────────────────────────────────────────────

function findRow_(sheet, company, title) {
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return null;

  const headers = data[0].map(h => h.toString().toLowerCase().replace(/\s+/g, '_'));
  const companyCol = headers.indexOf('company');
  const titleCol = headers.indexOf('job_title');
  const statusCol = headers.indexOf('status');

  if (companyCol < 0 || titleCol < 0) return null;

  const companyLower = (company || '').toLowerCase().trim();
  const titleLower = (title || '').toLowerCase().trim();

  for (let i = 1; i < data.length; i++) {
    const rowCompany = (data[i][companyCol] || '').toString().toLowerCase().trim();
    const rowTitle = (data[i][titleCol] || '').toString().toLowerCase().trim();

    if (rowCompany === companyLower &&
        (rowTitle === titleLower || rowTitle.includes(titleLower) || titleLower.includes(rowTitle))) {
      return {
        row: i + 1,
        data: {
          company: data[i][companyCol],
          title: data[i][titleCol],
          status: data[i][statusCol] || 'unknown'
        }
      };
    }
  }
  return null;
}

function jsonResponse_(data, code) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function getScriptProperty_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}
