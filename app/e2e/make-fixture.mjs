// Generates a 40-page sample PDF with mixed page sizes and a rotated page.
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { writeFileSync } from 'node:fs';

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
for (let i = 1; i <= 40; i++) {
  const size = i === 7 ? [842, 595] : i === 12 ? [420, 595] : [612, 792];
  const page = doc.addPage(size);
  const [w, h] = size;
  if (i === 9) page.setRotation(degrees(90));
  page.drawText(`Sample paper — page ${i}`, { x: 50, y: h - 60, size: 20, font: bold, color: rgb(0.1, 0.1, 0.1) });
  page.drawText(`Equation (${i}):   E = mc^2 + ${i}x`, { x: 50, y: h - 100, size: 14, font });
  for (let l = 0; l < 30; l++) {
    const y = h - 140 - l * 18;
    if (y < 40) break;
    page.drawText(`Line ${l + 1}: the quick brown fox jumps over the lazy dog while reading research papers.`, { x: 50, y, size: 10, font, color: rgb(0.2, 0.2, 0.2) });
  }
  page.drawRectangle({ x: 40, y: 30, width: w - 80, height: 2, color: rgb(0.6, 0.6, 0.6) });
}
writeFileSync(new URL('./fixtures/sample.pdf', import.meta.url), await doc.save());
console.log('wrote e2e/fixtures/sample.pdf');
