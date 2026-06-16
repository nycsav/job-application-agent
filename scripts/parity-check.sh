#!/usr/bin/env bash
# Parity check — confirm THIS machine matches the MacBook reference exactly.
# Run on the Mac Mini (or any clone): bash scripts/parity-check.sh
# Verifies byte-identical code + config + resumes (the gitignored PII files too,
# which git can't cover), plus the "running methodology" config + scheduled task.
set -uo pipefail
cd "$(dirname "$0")/.."
REF=".parity/reference.sha256"
FILES=(daemon/*.mjs lib/*.mjs agents/*.mjs config/candidate.json package.json materials/resumes/*.pdf claude-code-handoff/routine-prompt.md CLAUDE.md)

echo "════════ PARITY CHECK vs MacBook reference ════════"
[ -f "$REF" ] || { echo "❌ $REF missing — git pull origin mac-mini-handoff first."; exit 1; }

# 1. Byte-identical code + config + resumes
CUR=$(shasum -a 256 "${FILES[@]}" 2>/dev/null | sort -k2)
DIFF=$(diff <(echo "$CUR") "$REF")
if [ -z "$DIFF" ]; then
  echo "✅ FILES: all $(wc -l < "$REF" | tr -d ' ') code/config/resume files byte-identical to MacBook."
else
  echo "⚠️  FILES: mismatches below ('<' = this machine, '>' = MacBook reference):"
  echo "$DIFF"
  echo "   → For code: 'git pull origin mac-mini-handoff'. For resumes/candidate.json: re-AirDrop them."
fi

# 2. Running methodology / config
echo "──────── methodology ────────"
node -e "const c=JSON.parse(require('fs').readFileSync('config/candidate.json','utf8'));
console.log('  candidate answer keys :', Object.keys(c.easy_apply_answers).length, '(expect 39)');
console.log('  exclude_companies     :', (c.exclude_companies||[]).join(', '));
console.log('  resume default        :', c.resume.default_path);" 2>/dev/null || echo "  ❌ candidate.json unreadable"
echo "  resume PDFs           : $(ls materials/resumes/*.pdf 2>/dev/null | wc -l | tr -d ' ') (expect 4)"
echo "  cover letters staged  : $(ls output/cover-letters/*.md 2>/dev/null | wc -l | tr -d ' ') .md (regenerable; count may differ)"
echo "  Playwright Chromium   : $(ls -d ~/Library/Caches/ms-playwright/chromium-* 2>/dev/null | head -1 >/dev/null && echo 'installed ✓' || echo 'MISSING → npx playwright install chromium')"
echo "  node_modules          : $(test -d node_modules && echo 'present ✓' || echo 'MISSING → npm install')"
echo "  scheduled task        : $(test -f ~/.claude/scheduled-tasks/job-pipeline-daily/SKILL.md && echo 'present ✓' || echo 'NOT on this machine → recreate per MAC-MINI-SETUP.md (cron 0 9,13 * * 1-5, opus-4-8)')"
echo "  git HEAD              : $(git rev-parse --short HEAD 2>/dev/null) (MacBook ref built at/after 64c70ed)"

# 3. Live functional checks (read-only)
echo "──────── functional (read-only) ────────"
node --input-type=module -e "import {verifyResumes} from './lib/resume-router.mjs'; const r=await verifyResumes(); console.log('  resume-router verify  :', r.ok?'ok ✓':'MISSING '+r.missing.join(','));" 2>/dev/null || echo "  ❌ resume-router failed (run npm install)"
if [ -f .secrets/notion-token.txt ]; then
  NK=$(cat .secrets/notion-token.txt)
  N=$(curl -s -m 15 -X POST "https://api.notion.com/v1/databases/8ce2a0e3-0ab3-4416-bcfe-81295f4e4991/query" -H "Authorization: Bearer $NK" -H "Notion-Version: 2022-06-28" -H "Content-Type: application/json" -d '{"page_size":1}' | node -e "let r='';process.stdin.on('data',d=>r+=d);process.stdin.on('end',()=>{try{console.log(JSON.parse(r).object==='list'?'reachable ✓':'ERROR')}catch{console.log('UNREACHABLE')}})")
  echo "  Notion API            : $N"
else
  echo "  Notion API            : ❌ .secrets/notion-token.txt MISSING → re-AirDrop"
fi
echo "════════ done — anything not ✓ above needs attention ════════"
