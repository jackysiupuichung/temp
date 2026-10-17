/**
 * Paper store (agent design §5.2): PDFs keyed by content hash, with their text
 * extracted page by page using pdf.js in Node. Each page's text is also written
 * to its own file (`<sha>/p001.txt`, …) for the agent's Read/Grep tools.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type Paper = { sha256: string; pdfPath: string; pageDir: string; bytes: number; pageCount: number; pages: string[] };

export function pageFileName(page: number): string { return `p${String(page).padStart(3, '0')}.txt`; }

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<PdfJs> | null = null;
function pdfjs(): Promise<PdfJs> { return (pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs')); }

export async function extractPages(data: Uint8Array): Promise<string[]> {
  const lib = await pdfjs();
  const task = lib.getDocument({ data, useSystemFonts: true });
  const doc = await task.promise;
  const pages: string[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let text = '';
      let lastY: number | null = null;
      for (const item of tc.items) {
        if (!('str' in item)) continue;
        const y = item.transform[5];
        if (lastY !== null && Math.abs(y - lastY) > 2) text += '\n';
        else if (text && !text.endsWith(' ') && !text.endsWith('\n')) text += ' ';
        text += item.str;
        lastY = y;
      }
      pages.push(text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim());
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return pages;
}

export class PaperStore {
  private dir: string;
  private cache = new Map<string, Paper>();
  constructor(dataDir: string) { this.dir = path.join(dataDir, 'papers'); fs.mkdirSync(this.dir, { recursive: true }); }

  has(sha256: string): boolean { return this.cache.has(sha256) || (fs.existsSync(this.pdfPath(sha256)) && fs.existsSync(this.textPath(sha256))); }

  private pdfPath(sha: string) { return path.join(this.dir, `${sha}.pdf`); }
  private textPath(sha: string) { return path.join(this.dir, `${sha}.text.json`); }
  private pageDir(sha: string) { return path.join(this.dir, sha); }

  /** One text file per page, written once (papers stored before this existed get theirs on first load). */
  private writePageFiles(sha: string, pages: string[]) {
    const dir = this.pageDir(sha);
    if (fs.existsSync(path.join(dir, pageFileName(pages.length || 1)))) return;
    fs.mkdirSync(dir, { recursive: true });
    pages.forEach((text, i) => fs.writeFileSync(path.join(dir, pageFileName(i + 1)), `[p. ${i + 1}]\n${text}\n`));
  }

  async get(sha256: string): Promise<Paper | null> {
    const c = this.cache.get(sha256);
    if (c) return c;
    if (!this.has(sha256)) return null;
    const meta = JSON.parse(fs.readFileSync(this.textPath(sha256), 'utf8')) as { pages: string[] };
    this.writePageFiles(sha256, meta.pages);
    const p: Paper = { sha256, pdfPath: this.pdfPath(sha256), pageDir: this.pageDir(sha256), bytes: fs.statSync(this.pdfPath(sha256)).size, pageCount: meta.pages.length, pages: meta.pages };
    this.cache.set(sha256, p);
    return p;
  }

  /** Store the PDF bytes (verifying the hash) and extract its text. */
  async put(sha256: string, bytes: Buffer): Promise<Paper> {
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actual !== sha256) throw new Error('PDF hash mismatch');
    fs.writeFileSync(this.pdfPath(sha256), bytes);
    const pages = await extractPages(new Uint8Array(bytes));
    fs.writeFileSync(this.textPath(sha256), JSON.stringify({ pages }));
    this.writePageFiles(sha256, pages);
    const p: Paper = { sha256, pdfPath: this.pdfPath(sha256), pageDir: this.pageDir(sha256), bytes: bytes.length, pageCount: pages.length, pages };
    this.cache.set(sha256, p);
    return p;
  }

  readPdfBase64(sha256: string): string { return fs.readFileSync(this.pdfPath(sha256)).toString('base64'); }
}
