# Apps Script Score Filter Patch

## What to Change in Code.gs (Job Alert Scanner project)

Add this constant near the top of Code.gs, after the CONFIG block:

```javascript
// Score thresholds — roles below MIN_SCORE are silently skipped
const MIN_SCORE_FOR_SHEET = 5;     // Don't add to Jobs tab below this
const HIGH_PROFILE_SCORE = 7;      // Add to High Profile tab at this score
const AUTO_MATERIALS_SCORE = 8;    // Auto-generate resume + cover letter
```

Then in the function that writes rows to the sheet, add this check BEFORE the `sheet.appendRow()` call:

```javascript
// Filter out low-score noise
if (job.score < MIN_SCORE_FOR_SHEET) {
  console.log(`[SKIP] ${job.title} at ${job.company} — score ${job.score} below threshold ${MIN_SCORE_FOR_SHEET}`);
  continue;  // or return, depending on loop structure
}
```

## Why
The sheet currently has 55 rows, many with scores 0-3. These will never be applied to and create noise. By filtering at score >= 5, only roles worth tracking make it to the sheet.

## Apps Script Project
- URL: https://script.google.com/u/2/home/projects/1saSsIzHuqNocF0BoGGeBC0qJnMlq3IWlSxJVoawDi6ARkZPlkZmuB-B_/edit
- Sheet ID: 1Wd0x_0fEAyScgMKB9neneuMIo3Sgln-CMytWMF8m6eI
