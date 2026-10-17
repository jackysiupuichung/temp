import { PDFDocument, StandardFonts, rgb, degrees, BlendMode, type PDFPage } from 'pdf-lib';
import type { DocumentRecord, Stroke, TextBox } from '../model/types';
import { getBlob } from '../db/db';
import { getCachedOutline, outlineToSvgPath } from '../ink/render';
import { svgPlacementForRotation, displayToUserSpace } from '../geometry/transform';

function hexToRgb(hex: string) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return rgb(0, 0, 0);
  return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
}

/**
 * Flatten ink, highlights and text into a copy of the PDF, keeping vector
 * quality. The original bytes stored in the app are never modified.
 */
export async function exportAnnotatedPdf(
  doc: DocumentRecord, strokesByPage: Record<string, Stroke[]>, textBoxesByPage: Record<string, TextBox[]>,
): Promise<Blob> {
  let pdf: PDFDocument;
  if (doc.pdfBlobId) {
    const blob = await getBlob(doc.pdfBlobId);
    if (!blob) throw new Error('Original PDF is missing');
    pdf = await PDFDocument.load(await blob.arrayBuffer(), { ignoreEncryption: true });
  } else {
    pdf = await PDFDocument.create();
  }
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const originalPages = doc.pdfBlobId ? pdf.getPages() : [];

  // Build output page list in display order, inserting blank pages.
  const targets: { page: PDFPage; rec: DocumentRecord['pages'][number] }[] = [];
  let outIndex = 0;
  for (const rec of doc.pages) {
    if (rec.kind === 'pdf' && rec.pdfPageNumber) {
      const p = originalPages[rec.pdfPageNumber - 1];
      if (!p) continue;
      targets.push({ page: p, rec });
    } else {
      const p = pdf.insertPage(outIndex, [rec.width, rec.height]);
      targets.push({ page: p, rec });
    }
    outIndex++;
  }

  for (const { page, rec } of targets) {
    const rotation = page.getRotation().angle;
    const box = page.getCropBox();
    const userW = box.width, userH = box.height;
    const place = svgPlacementForRotation(userW, userH, rotation);
    // Account for a non-zero crop box origin.
    const originX = place.x + box.x, originY = place.y + box.y;
    const strokes = strokesByPage[rec.id] ?? [];
    const boxes = textBoxesByPage[rec.id] ?? [];

    // Highlights first (under ink), multiply blend so text shows through.
    for (const s of strokes) {
      if (s.tool !== 'highlighter') continue;
      const d = outlineToSvgPath(getCachedOutline(s));
      if (!d) continue;
      page.drawSvgPath(d, { x: originX, y: originY, rotate: degrees(place.rotate), color: hexToRgb(s.color), opacity: 0.4, borderWidth: 0, blendMode: BlendMode.Multiply });
    }
    for (const s of strokes) {
      if (s.tool !== 'pen') continue;
      const outline = getCachedOutline(s);
      if (outline.length < 3) {
        const p = s.points[0];
        const u = displayToUserSpace(p.x, p.y, userW, userH, rotation);
        page.drawCircle({ x: u.x + box.x, y: u.y + box.y, size: s.baseWidth * 0.4, color: hexToRgb(s.color), opacity: s.opacity });
        continue;
      }
      page.drawSvgPath(outlineToSvgPath(outline), { x: originX, y: originY, rotate: degrees(place.rotate), color: hexToRgb(s.color), opacity: s.opacity, borderWidth: 0 });
    }
    for (const t of boxes) {
      const lines = wrapForFont(t.text, font, t.fontSize, t.width - 8);
      const lh = t.fontSize * 1.3;
      lines.forEach((line, i) => {
        // baseline position in display coords
        const dx = t.x + 4, dy = t.y + 4 + i * lh + t.fontSize * 0.95;
        const u = displayToUserSpace(dx, dy, userW, userH, rotation);
        try {
          page.drawText(line, { x: u.x + box.x, y: u.y + box.y, size: t.fontSize, font, color: hexToRgb(t.color), rotate: degrees(place.rotate) });
        } catch {
          page.drawText(line.replace(/[^\x20-\x7e]/g, '?'), { x: u.x + box.x, y: u.y + box.y, size: t.fontSize, font, color: hexToRgb(t.color), rotate: degrees(place.rotate) });
        }
      });
    }
  }
  const bytes = await pdf.save({ useObjectStreams: true });
  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}

function wrapForFont(text: string, font: { widthOfTextAtSize(t: string, s: number): number }, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  const measure = (s: string) => { try { return font.widthOfTextAtSize(s, size); } catch { return s.length * size * 0.5; } };
  for (const para of text.split('\n')) {
    const words = para.split(' ');
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (measure(test) > maxWidth && line) { out.push(line); line = w; } else line = test;
    }
    out.push(line);
  }
  return out;
}
