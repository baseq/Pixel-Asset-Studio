import type { ReactElement } from 'react'

const base = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export const Icons: Record<string, ReactElement> = {
  pencil: <svg {...base}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>,
  eraser: <svg {...base}><path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l9.6-9.6a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 19" /><path d="M22 21H7" /><path d="m5 11 9 9" /></svg>,
  line: <svg {...base}><path d="M5 19 19 5" /></svg>,
  rect: <svg {...base}><rect x="4" y="5" width="16" height="14" rx="1" /></svg>,
  ellipse: <svg {...base}><ellipse cx="12" cy="12" rx="8" ry="6.5" /></svg>,
  fill: <svg {...base}><path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2a2 2 0 0 0 2.8 0Z" /><path d="m5 2 5 5" /><path d="M2 13h15" /><path d="M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4Z" /></svg>,
  picker: <svg {...base}><path d="m2 22 1-1h3l9-9" /><path d="M3 21v-3l9-9" /><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z" /></svg>,
  select: <svg {...base} strokeDasharray="3 3"><rect x="4" y="4" width="16" height="16" rx="1" /></svg>,
  hand: <svg {...base}><path d="M18 11V6a2 2 0 0 0-4 0v5" /><path d="M14 10V4a2 2 0 0 0-4 0v6" /><path d="M10 10.5V6a2 2 0 0 0-4 0v8" /><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.9-2.6L3.2 15.4a2 2 0 0 1 3.1-2.5L8 15" /></svg>,
  filled: <svg {...base}><rect x="4" y="5" width="16" height="14" rx="1" fill="currentColor" fillOpacity="0.45" /></svg>,
  onion: <svg {...base}><rect x="7" y="7" width="12" height="12" rx="2" /><path d="M4 15V6a2 2 0 0 1 2-2h9" strokeOpacity="0.45" /><path d="M9.5 12.5l2 2 3.5-4" /></svg>,
  fit: <svg {...base}><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" /><rect x="8" y="8" width="8" height="8" rx="1" /></svg>,
  grid: <svg {...base}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></svg>,
  play: <svg {...base} fill="currentColor" stroke="none"><path d="M6 4l14 8-14 8Z" /></svg>,
  pause: <svg {...base} fill="currentColor" stroke="none"><rect x="5" y="4" width="5" height="16" rx="1" /><rect x="14" y="4" width="5" height="16" rx="1" /></svg>,
  eye: <svg {...base}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>,
  eyeOff: <svg {...base}><path d="M3 3l18 18" /><path d="M10.6 10.6a3 3 0 0 0 4.2 4.2" /><path d="M9.9 5.2A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2" /><path d="M6.6 6.6C3.7 8.5 2 12 2 12s3.5 7 10 7c1.5 0 2.8-.3 4-.8" /></svg>,
  sun: <svg {...base}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>,
  moon: <svg {...base}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /></svg>,
  monitor: <svg {...base}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>,
  undo: <svg {...base}><path d="M3 7v6h6" /><path d="M21 17a9 9 0 0 0-15-6.7L3 13" /></svg>,
  redo: <svg {...base}><path d="M21 7v6h-6" /><path d="M3 17a9 9 0 0 1 15-6.7L21 13" /></svg>,
  plus: <svg {...base}><path d="M12 5v14M5 12h14" /></svg>,
  minus: <svg {...base}><path d="M5 12h14" /></svg>,
  logo: <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="2" y="2" width="4" height="4" /><rect x="8" y="2" width="4" height="4" /><rect x="2" y="8" width="4" height="4" /><rect x="8" y="8" width="4" height="4" /></svg>
}
