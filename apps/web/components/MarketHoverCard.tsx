"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const CARD_W = 320;
const OPEN_DELAY = 140;

/**
 * Desktop hover card. Wraps a trigger and renders `content` in a body portal so
 * it escapes scroll/overflow clipping. Positions to the right of the trigger,
 * flipping left when there's no room. No-op on touch (hover never fires).
 */
export function MarketHoverCard({
  children,
  content,
  className,
}: {
  children: ReactNode;
  content: ReactNode;
  className?: string;
}) {
  const triggerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const place = () => {
    const t = triggerRef.current?.getBoundingClientRect();
    if (!t) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = t.right + 10;
    if (left + CARD_W > vw - 8) left = t.left - CARD_W - 10;
    if (left < 8) left = 8;
    const cardH = cardRef.current?.offsetHeight ?? 240;
    let top = t.top;
    if (top + cardH > vh - 8) top = Math.max(8, vh - cardH - 8);
    setPos({ left, top });
  };

  useLayoutEffect(() => {
    if (open) place();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onEnter = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), OPEN_DELAY);
  };
  const onLeave = () => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  };

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return (
    <div ref={triggerRef} onMouseEnter={onEnter} onMouseLeave={onLeave} className={className}>
      {children}
      {mounted && open
        ? createPortal(
            <div
              ref={cardRef}
              className="fade-in pointer-events-none fixed z-50"
              style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: CARD_W }}
            >
              <div className="overflow-hidden rounded-md border border-border-strong bg-surface shadow-pop">
                {content}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
