#!/usr/bin/env node
/**
 * Simple md → docx converter for cover letters
 * Arial 11pt, single-column, ATS-friendly
 * Usage: node scripts/md-to-docx.mjs <input.md> <output.docx>
 */
import { Document, Packer, Paragraph, TextRun, AlignmentType } from 'docx';
import fs from 'fs';
import path from 'path';

const FONT = 'Arial';
const SIZE = 22; // 11pt

function parseInline(text) {
  const runs = [];
  const regex = /\*\*(.+?)\*\*|\[(.+?)\]\((.+?)\)/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      runs.push(new TextRun({ text: text.slice(lastIndex, match.index), font: FONT, size: SIZE }));
    }
    if (match[1]) {
      runs.push(new TextRun({ text: match[1], font: FONT, size: SIZE, bold: true }));
    } else if (match[2]) {
      runs.push(new TextRun({ text: match[2], font: FONT, size: SIZE }));
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    runs.push(new TextRun({ text: text.slice(lastIndex), font: FONT, size: SIZE }));
  }
  return runs.length ? runs : [new TextRun({ text, font: FONT, size: SIZE })];
}

function mdToParagraphs(md) {
  const lines = md.split('\n');
  const paras = [];
  for (const line of lines) {
    const t = line.replace(/\s+$/, '');
    if (!t.trim()) {
      paras.push(new Paragraph({ children: [new TextRun({ text: '', font: FONT, size: SIZE })] }));
      continue;
    }
    if (t.startsWith('# ')) {
      paras.push(new Paragraph({
        children: [new TextRun({ text: t.slice(2), font: FONT, size: 28, bold: true })],
        spacing: { before: 200, after: 100 }
      }));
    } else if (t.startsWith('## ')) {
      paras.push(new Paragraph({
        children: [new TextRun({ text: t.slice(3), font: FONT, size: 24, bold: true })],
        spacing: { before: 200, after: 100 }
      }));
    } else if (t.startsWith('- ') || t.startsWith('* ')) {
      paras.push(new Paragraph({
        children: parseInline(t.slice(2)),
        bullet: { level: 0 },
        spacing: { after: 80 }
      }));
    } else {
      paras.push(new Paragraph({
        children: parseInline(t),
        spacing: { after: 160 }
      }));
    }
  }
  return paras;
}

async function main() {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    console.error('Usage: node md-to-docx.mjs <input.md> <output.docx>');
    process.exit(1);
  }
  const md = fs.readFileSync(inputPath, 'utf8');
  const doc = new Document({
    creator: 'Sav Banerjee',
    styles: { default: { document: { run: { font: FONT, size: SIZE } } } },
    sections: [{
      properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } },
      children: mdToParagraphs(md)
    }]
  });
  const buf = await Packer.toBuffer(doc);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buf);
  console.log(`✓ ${outputPath} (${buf.length} bytes)`);
}

main().catch(e => { console.error(e); process.exit(1); });
