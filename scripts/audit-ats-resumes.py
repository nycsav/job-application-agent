#!/usr/bin/env python3
from pathlib import Path
from zipfile import ZipFile
import json
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
RESUME_DIR = ROOT / "materials" / "resumes" / "optimized"

REQUIRED_KEYWORDS = [
    "agentic",
    "mcp",
    "claude",
    "gemini",
    "langgraph",
    "rag",
    "pilot-to-production",
    "production",
    "enterprise",
    "strategy",
    "deployment",
    "governance",
    "google i/o 2026",
    "managed agents api",
    "frontier",
    "c-suite",
    "value realization"
]

BLOCKED_XML_MARKERS = {
    "tables": "<w:tbl",
    "drawings": "<w:drawing",
    "text_boxes": "txbxContent",
    "footnotes": "footnotes.xml",
    "endnotes": "endnotes.xml",
    "comments": "comments.xml",
    "tracked_insertions": "<w:ins",
    "tracked_deletions": "<w:del",
    "multi_columns": "<w:cols w:num="
}


def xml_text(xml):
    text = re.sub(r"<w:tab\\s*/>", " ", xml)
    text = re.sub(r"</w:p>", "\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    return (
        text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&apos;", "'")
    )


def audit_docx(path):
    result = {
        "file": str(path.relative_to(ROOT)),
        "pass": True,
        "blockedObjects": [],
        "missingKeywords": [],
        "paragraphCount": 0,
        "wordCount": 0
    }

    with ZipFile(path) as z:
        names = set(z.namelist())
        document_xml = z.read("word/document.xml").decode("utf-8")
        full_xml = document_xml + "\n".join(names)
        text = xml_text(document_xml).lower()

    for label, marker in BLOCKED_XML_MARKERS.items():
        if marker in full_xml:
            result["blockedObjects"].append(label)

    result["missingKeywords"] = [kw for kw in REQUIRED_KEYWORDS if kw not in text]
    result["paragraphCount"] = document_xml.count("<w:p")
    result["wordCount"] = len(re.findall(r"[a-zA-Z0-9+#./-]+", text))
    result["pass"] = not result["blockedObjects"] and not result["missingKeywords"] and 450 <= result["wordCount"] <= 1300
    return result


def main():
    files = sorted(RESUME_DIR.glob("*_ATS_2026.docx"))
    if not files:
        print(f"No optimized resumes found in {RESUME_DIR}", file=sys.stderr)
        return 1

    report = {
        "resumeDir": str(RESUME_DIR.relative_to(ROOT)),
        "results": [audit_docx(path) for path in files]
    }
    out_dir = ROOT / "output" / "resume-ats-audit"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "ats-audit-report.json"
    out_path.write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    return 0 if all(item["pass"] for item in report["results"]) else 2


if __name__ == "__main__":
    raise SystemExit(main())
