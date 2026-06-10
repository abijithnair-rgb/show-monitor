'use client';
import { useEffect } from 'react';

// Floating, JS-positioned tooltip. Uses event delegation on [data-tip] so it
// works for markup rendered via dangerouslySetInnerHTML, inside scroll/sticky.
export default function Tooltip() {
  useEffect(() => {
    const tipEl = document.getElementById('floating-tip');
    if (!tipEl) return;
    let cur = null;
    function position(e) {
      const pad = 12,
        w = tipEl.offsetWidth,
        h = tipEl.offsetHeight;
      let x = e.clientX + 14,
        y = e.clientY + 16;
      if (x + w + pad > innerWidth) x = e.clientX - w - 14;
      if (y + h + pad > innerHeight) y = e.clientY - h - 16;
      tipEl.style.left = Math.max(pad, x) + 'px';
      tipEl.style.top = Math.max(pad, y) + 'px';
    }
    function onOver(e) {
      const el = e.target.closest('[data-tip]');
      if (el) {
        cur = el;
        tipEl.innerHTML = el.getAttribute('data-tip');
        tipEl.style.opacity = '1';
        position(e);
      }
    }
    function onMove(e) {
      if (cur) position(e);
    }
    function onOut(e) {
      if (cur && !e.relatedTarget?.closest?.('[data-tip]')) {
        cur = null;
        tipEl.style.opacity = '0';
      }
    }
    function onScroll() {
      if (cur) {
        cur = null;
        tipEl.style.opacity = '0';
      }
    }
    document.addEventListener('mouseover', onOver);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseout', onOut);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseout', onOut);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, []);
  return <div id="floating-tip" />;
}
