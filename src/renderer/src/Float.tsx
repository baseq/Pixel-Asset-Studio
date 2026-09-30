import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

/**
 * A floating panel the user can drag by its grip. Panels start at their CSS-anchored position;
 * once dragged, the position is stored per panel in localStorage. Double-click the grip to reset.
 */
const KEY = 'pas.panels'
type Pos = { x: number; y: number }

function readAll(): Record<string, Pos> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Pos>
  } catch {
    return {}
  }
}
function writeOne(id: string, pos: Pos | null): void {
  try {
    const all = readAll()
    if (pos) all[id] = pos
    else delete all[id]
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* ignore */
  }
}

export function Float(p: { id: string; className: string; children: ReactNode; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<Pos | null>(() => readAll()[p.id] ?? null)
  const drag = useRef<{ dx: number; dy: number } | null>(null)

  const clamp = useCallback((x: number, y: number): Pos => {
    const el = ref.current
    const w = el?.offsetWidth ?? 0
    const h = el?.offsetHeight ?? 0
    return { x: Math.max(0, Math.min(window.innerWidth - Math.min(w, 80), x)), y: Math.max(0, Math.min(window.innerHeight - 40, y)) }
  }, [])

  const onGripDown = (e: React.PointerEvent): void => {
    const el = ref.current
    if (!el || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const r = el.getBoundingClientRect()
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top }
    setPos({ x: r.left, y: r.top })
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onGripMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    setPos(clamp(e.clientX - d.dx, e.clientY - d.dy))
  }
  const onGripUp = (): void => {
    if (!drag.current) return
    drag.current = null
    setPos((cur) => {
      writeOne(p.id, cur)
      return cur
    })
  }
  const reset = (): void => {
    setPos(null)
    writeOne(p.id, null)
  }

  // Keep panels on screen when the window shrinks.
  useEffect(() => {
    const onResize = (): void => setPos((cur) => (cur ? clamp(cur.x, cur.y) : cur))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clamp])

  const style: CSSProperties | undefined = pos
    ? { ...p.style, left: pos.x, top: pos.y, right: 'auto', bottom: 'auto', transform: 'none' }
    : p.style
  return (
    <div ref={ref} className={'float ' + p.className + (pos ? ' moved' : '')} style={style}>
      <div
        className="grip"
        role="button"
        aria-label="Drag to move panel (double-click to reset)"
        title="Drag to move · double-click to reset"
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
        onDoubleClick={reset}
      >
        <svg width="8" height="12" viewBox="0 0 8 12" fill="currentColor" aria-hidden="true">
          <circle cx="2" cy="2" r="1.3" /><circle cx="6" cy="2" r="1.3" /><circle cx="2" cy="6" r="1.3" /><circle cx="6" cy="6" r="1.3" /><circle cx="2" cy="10" r="1.3" /><circle cx="6" cy="10" r="1.3" />
        </svg>
      </div>
      {p.children}
    </div>
  )
}
