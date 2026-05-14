/**
 * DOCX Builder — converts filled markdown into ATS-optimized .docx
 * Uses docx-js. No individual files saved to disk unless explicitly requested.
 * Returns a Buffer that can be uploaded to Drive or written to disk.
 */

import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType, BorderStyle, TabStopPosition, TabStopType,
  convertInchesToTwip
} from 'docx';

const FONT = 'Arial';
const SIZE_BODY = 22;       // 11pt in half-points
const SIZE_NAME = 32;       // 16pt
const SIZE_H2 = 26;         // 13pt
const SIZE_H3 = 24;         // 12pt
const COLOR_TEXT = '1a1a1a';
const COLOR_ACCENT = '333333';

/**
 * Parse inline markdown (bold, links) into TextRun array
 */
function parseInline(text, baseSize = SIZE_BODY) {
  const runs = [];
  const regex = /\*\*(.+?)\*\*|\[(.+?)\]\((.+?)\)/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Text before this match
    if (match.index > lastIndex) {
      runs.push(new TextRun({
        text: text.slice(lastIndex, match.index),
        font: FONT, size: baseSize, color: COLOR_TEXT
      }));
    }

    if (match[1]) {
      // Bold
      runs.push(new TextRun({
        text: match[1],
        font: FONT, size: baseSize, color: COLOR_TEXT, bold: true
      }));
    } else if (match[2] && match[3]) {
      // Link — render as plain text (ATS can't follow hyperlinks reliably)
      runs.push(new TextRun({
        text: match[2],
        font: FONT, size: baseSize, color: COLOR_ACCENT
      }));
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < text.length) {
    runs.push(new TextRun({
      text: text.slice(lastIndex),
      font: FONT, size: baseSize, color: COLOR_TEXT
    }));
  }

  return runs.length > 0 ? runs : [new TextRun({ text, font: FONT, size: baseSize, color: COLOR_TEXT })];
}

/**
 * Parse markdown into structured sections
 */
function parseMd(md) {
  const lines = md.split('\n');
  const sections = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '---') continue;

    if (trimmed.startsWith('# ')) {
      sections.push({ type: 'h1', text: trimmed.slice(2) });
    } else if (trimmed.startsWith('## ')) {
      sections.push({ type: 'h2', text: trimmed.slice(3) });
    } else if (trimmed.startsWith('### ')) {
      sections.push({ type: 'h3', text: trimmed.slice(4) });
    } else if (trimmed.startsWith('- ')) {
      sections.push({ type: 'bullet', text: trimmed.slice(2) });
    } else {
      sections.push({ type: 'text', text: trimmed });
    }
  }

  return sections;
}

/**
 * Convert parsed sections into docx paragraphs
 */
function buildParagraphs(sections) {
  const paragraphs = [];

  for (const s of sections) {
    switch (s.type) {
      case 'h1':
        paragraphs.push(new Paragraph({
          children: [new TextRun({
            text: s.text,
            font: FONT, size: SIZE_NAME, bold: true, color: COLOR_TEXT
          })],
          alignment: AlignmentType.CENTER,
          spacing: { after: 120 }
        }));
        break;

      case 'h2':
        // Section header with bottom border
        paragraphs.push(new Paragraph({
          children: [new TextRun({
            text: s.text.toUpperCase(),
            font: FONT, size: SIZE_H2, bold: true, color: COLOR_TEXT
          })],
          spacing: { before: 240, after: 80 },
          border: {
            bottom: { style: BorderStyle.SINGLE, size: 1, color: '999999' }
          }
        }));
        break;

      case 'h3':
        paragraphs.push(new Paragraph({
          children: parseInline(s.text, SIZE_H3),
          spacing: { before: 160, after: 40 }
        }));
        break;

      case 'bullet':
        paragraphs.push(new Paragraph({
          children: parseInline(s.text),
          bullet: { level: 0 },
          spacing: { after: 40 },
          indent: { left: convertInchesToTwip(0.25) }
        }));
        break;

      case 'text':
        paragraphs.push(new Paragraph({
          children: parseInline(s.text),
          spacing: { after: 80 }
        }));
        break;
    }
  }

  return paragraphs;
}

/**
 * Generate a .docx Buffer from markdown content
 */
export async function markdownToDocx(markdown) {
  const sections = parseMd(markdown);
  const paragraphs = buildParagraphs(sections);

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          margin: {
            top: convertInchesToTwip(0.75),
            bottom: convertInchesToTwip(0.75),
            left: convertInchesToTwip(0.875),
            right: convertInchesToTwip(0.875)
          }
        }
      },
      children: paragraphs
    }],
    styles: {
      default: {
        document: {
          run: { font: FONT, size: SIZE_BODY, color: COLOR_TEXT }
        }
      }
    }
  });

  return Packer.toBuffer(doc);
}

/**
 * Generate filename from role config
 */
export function makeFilename(candidate, role, type) {
  const namePart = candidate.name.replace(/\s+/g, '_');
  const companyPart = role.company.replace(/[\s/]+/g, '_');
  const titlePart = role.title.replace(/[\s,—/]+/g, '_').replace(/_+/g, '_');
  return `${namePart}_${companyPart}_${titlePart}_${type}.docx`;
}
