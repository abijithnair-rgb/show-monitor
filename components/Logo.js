'use client';
import { useEffect, useState } from 'react';

// Seekho header logo. Probes /seekho-logo.png client-side (so a missing file
// never flashes a broken image); shows a brand-gradient "S" until it loads.
export default function Logo() {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const img = new window.Image();
    img.onload = () => setOk(true);
    img.onerror = () => setOk(false);
    img.src = '/seekho-logo.png';
  }, []);

  if (ok) {
    /* eslint-disable-next-line @next/next/no-img-element */
    return <img src="/seekho-logo.png" alt="Seekho" className="w-9 h-9 rounded-lg object-contain" />;
  }
  return (
    <div
      className="w-9 h-9 rounded-lg flex items-center justify-center"
      style={{ background: 'linear-gradient(135deg, #F0317E 0%, #A23BE0 45%, #F59E5B 100%)' }}
      aria-label="Seekho"
    >
      <span className="text-white font-extrabold text-lg leading-none">S</span>
    </div>
  );
}
