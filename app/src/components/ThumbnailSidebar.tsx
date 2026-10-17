import { memo, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PageRecord } from '../model/types';
import { useEditorStore } from '../store/editorStore';
import { getPage, loadPdf, renderPageToCanvas } from '../pdf/pdf';
import { IconPlus, IconTrash } from './icons';

const THUMB_W = 120;
const cache = new Map<string, string>(); // `${blobId}:${pageNumber}` -> data URL

async function renderThumb(blobId: string, pageNumber: number, width: number): Promise<string> {
  const key = `${blobId}:${pageNumber}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pdf: PDFDocumentProxy = await loadPdf(blobId);
  const page = await getPage(pdf, pageNumber);
  const c = await renderPageToCanvas(page, (THUMB_W * 2) / width).promise;
  const url = c.toDataURL('image/jpeg', 0.7);
  c.width = 0; c.height = 0;
  cache.set(key, url);
  return url;
}

const ThumbItem = memo(function ThumbItem({ page, index, current, blobId }: { page: PageRecord; index: number; current: boolean; blobId: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const { requestJumpToPage, insertBlankPageAfter, deleteBlankPage } = useEditorStore.getState();

  useEffect(() => {
    if (page.kind !== 'pdf' || !blobId || !page.pdfPageNumber) return;
    const el = ref.current!;
    let cancelled = false;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        renderThumb(blobId, page.pdfPageNumber!, page.width).then((u) => { if (!cancelled) setSrc(u); }).catch(() => {});
      }
    }, { root: el.closest('.sidebar'), rootMargin: '300px' });
    io.observe(el);
    return () => { cancelled = true; io.disconnect(); };
  }, [page, blobId]);

  useEffect(() => { if (current) ref.current?.scrollIntoView({ block: 'nearest' }); }, [current]);

  const h = Math.round((THUMB_W * page.height) / page.width);
  return (
    <div ref={ref} className={'thumb-item' + (current ? ' current' : '')}>
      <button className="thumb" onClick={() => requestJumpToPage(index)} aria-label={`Go to page ${index + 1}`} aria-current={current ? 'page' : undefined}>
        {src ? <img src={src} alt="" width={THUMB_W} height={h} /> : <div className="blank" style={{ width: THUMB_W, height: h }} />}
      </button>
      <div className="num">
        <span>{index + 1}</span>
        <button className="btn mini" title="Insert blank page after" aria-label={`Insert blank page after page ${index + 1}`} onClick={() => insertBlankPageAfter(index)}><IconPlus /></button>
        {page.kind === 'blank' && <button className="btn mini danger" title="Delete blank page" aria-label={`Delete page ${index + 1}`} onClick={() => { if (window.confirm('Delete this page and its annotations?')) deleteBlankPage(page.id); }}><IconTrash /></button>}
      </div>
    </div>
  );
});

export function ThumbnailSidebar() {
  const doc = useEditorStore((s) => s.doc)!;
  const current = useEditorStore((s) => s.currentPageIndex);
  return (
    <nav className="sidebar" aria-label="Pages">
      {doc.pages.map((p, i) => <ThumbItem key={p.id} page={p} index={i} current={i === current} blobId={doc.pdfBlobId} />)}
    </nav>
  );
}
