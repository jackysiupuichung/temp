import { useEffect, useRef, type ReactNode, type CSSProperties } from 'react';

/** Small non-modal popover anchored below its parent `.group`. Closes on outside pointerdown or Escape. */
export function Popover({ open, onClose, children, align = 'left', style }: { open: boolean; onClose: () => void; children: ReactNode; align?: 'left' | 'right'; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const el = ref.current;
      if (!el) return;
      if (el.contains(e.target as Node)) return;
      // clicks on the anchor button are handled by the button itself
      if ((e.target as HTMLElement).closest?.('[data-popover-anchor]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={ref} className="popover" role="dialog" style={{ top: 'calc(100% + 6px)', [align]: 0, ...style }}>
      {children}
    </div>
  );
}
