import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

/**
 * Pointer-driven drag-to-reorder for a row or column of items.
 * - the drag starts only after the pointer moves a few pixels, so plain clicks still work
 * - `ghost` is the pointer position where the caller draws a floating copy of the item
 * - `drop` is the insertion slot (0..count) shown as a marker between items
 * On release, onMove(from, insertAt) is called when the order would change.
 */
export interface ReorderState {
  from: number
  drop: number
  ghost: { x: number; y: number; dx: number; dy: number }
}

export function useReorder(o: {
  axis: 'x' | 'y'
  /** Selector for the item elements inside the container, in visual order. */
  itemSelector: string
  onMove: (from: number, insertAt: number) => void
}) {
  const containerRef = useRef<HTMLElement | null>(null)
  const [state, setState] = useState<ReorderState | null>(null)
  const pending = useRef<{ from: number; x: number; y: number; dx: number; dy: number } | null>(null)
  const live = useRef<ReorderState | null>(null)

  const slotAt = useCallback(
    (x: number, y: number): number => {
      const el = containerRef.current
      if (!el) return 0
      const items = Array.from(el.querySelectorAll<HTMLElement>(o.itemSelector))
      let slot = items.length
      for (let i = 0; i < items.length; i++) {
        const r = (items[i] as HTMLElement).getBoundingClientRect()
        const mid = o.axis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2
        if ((o.axis === 'x' ? x : y) < mid) {
          slot = i
          break
        }
      }
      return slot
    },
    [o.axis, o.itemSelector]
  )

  const onPointerDown = useCallback((e: ReactPointerEvent, index: number) => {
    if (e.button !== 0) return
    const t = e.target as HTMLElement
    if (t.closest('input, select, textarea')) return
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    pending.current = { from: index, x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top }
  }, [])

  useEffect(() => {
    const move = (e: PointerEvent): void => {
      const p = pending.current
      if (!p) return
      if (!live.current) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 4) return
        live.current = { from: p.from, drop: p.from, ghost: { x: e.clientX, y: e.clientY, dx: p.dx, dy: p.dy } }
      }
      live.current = { ...live.current, drop: slotAt(e.clientX, e.clientY), ghost: { ...live.current.ghost, x: e.clientX, y: e.clientY } }
      setState(live.current)
      e.preventDefault()
    }
    const up = (): void => {
      const s = live.current
      pending.current = null
      live.current = null
      setState(null)
      if (!s) return
      // Dropping right before or right after itself is a no-op.
      if (s.drop === s.from || s.drop === s.from + 1) return
      o.onMove(s.from, s.drop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [slotAt, o.onMove])

  return { containerRef, state, onPointerDown }
}

/** Index the item lands on after removing it from `from` and inserting at slot `insertAt`. */
export const targetIndex = (from: number, insertAt: number): number => (insertAt > from ? insertAt - 1 : insertAt)
