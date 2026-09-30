import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ellipsePoints, linePoints, rectPoints, type Point } from '../../core/geometry'
import { parseColor } from '../../core/palettes'
import { renderFrame } from '../../core/render'
import { celKey, type Project, type Sprite } from '../../core/types'

export type Tool = 'pencil' | 'eraser' | 'line' | 'rect' | 'ellipse' | 'fill' | 'picker' | 'hand' | 'select'

export interface Selection { x: number; y: number; w: number; h: number }

interface Props {
  project: Project
  /** Engine revision of `project`; used to know when our local strokes have round-tripped. */
  revision: number
  sprite: Sprite
  frame: number
  layerIndex: number
  zoom: number
  tool: Tool
  color: number
  filled: boolean
  grid: boolean
  onion: boolean
  run: (name: string, params: unknown) => Promise<unknown>
  begin: (label: string) => void
  end: () => void
  onPick: (color: number) => void
  onHover: (p: Point | null) => void
  selection: Selection | null
  onSelection: (s: Selection | null) => void
  panMode: boolean
}

interface Shape {
  tool: 'line' | 'rect' | 'ellipse'
  start: Point
  cur: Point
}

function normalize(a: Point, b: Point): Selection {
  const x = Math.min(a[0], b[0])
  const y = Math.min(a[1], b[1])
  return { x, y, w: Math.abs(b[0] - a[0]) + 1, h: Math.abs(b[1] - a[1]) + 1 }
}

function shapeParams(s: Shape, color: number, filled: boolean, layer: number, frame: number) {
  const [x0, y0] = s.start
  const [x1, y1] = s.cur
  if (s.tool === 'line') return { name: 'draw_line', params: { x0, y0, x1, y1, color, layer, frame } }
  const x = Math.min(x0, x1)
  const y = Math.min(y0, y1)
  const width = Math.abs(x1 - x0) + 1
  const height = Math.abs(y1 - y0) + 1
  return {
    name: s.tool === 'rect' ? 'draw_rect' : 'draw_ellipse',
    params: { x, y, width, height, color, filled, layer, frame }
  }
}

function shapePoints(s: Shape, filled: boolean): Point[] {
  const [x0, y0] = s.start
  const [x1, y1] = s.cur
  if (s.tool === 'line') return linePoints(x0, y0, x1, y1)
  const x = Math.min(x0, x1)
  const y = Math.min(y0, y1)
  const w = Math.abs(x1 - x0) + 1
  const h = Math.abs(y1 - y0) + 1
  return s.tool === 'rect' ? rectPoints(x, y, w, h, filled) : ellipsePoints(x, y, w, h, filled)
}

export function Canvas(p: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [shape, setShape] = useState<Shape | null>(null)
  const [marquee, setMarquee] = useState<{ start: Point; cur: Point } | null>(null)
  const moving = useRef<{ start: Point; last: Point; sel: Selection } | null>(null)
  const [moveOffset, setMoveOffset] = useState<Point | null>(null)
  const drawing = useRef<{ last: Point } | null>(null)
  // Pixels of the current stroke, painted locally the moment the pointer moves. The real edit goes to the
  // main process and comes back as a new state; the overlay is dropped once that state has arrived.
  const overlay = useRef(new Map<number, number>())
  const [overlayTick, setOverlayTick] = useState(0)
  const pending = useRef(0)
  const settleRev = useRef(0)
  const revisionRef = useRef(p.revision)
  revisionRef.current = p.revision
  const { project, sprite, frame, zoom } = p

  const layer = sprite.layers[p.layerIndex] ?? sprite.layers[0]
  const cel = layer && sprite.frames[frame] ? sprite.cels[celKey(layer.id, (sprite.frames[frame] as { id: string }).id)] : undefined

  const settle = (): void => {
    if (overlay.current.size && pending.current === 0 && !drawing.current && revisionRef.current >= settleRev.current) {
      overlay.current.clear()
      setOverlayTick((n) => n + 1)
    }
  }
  useEffect(settle, [p.revision]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Paint pixels locally right away, and send the edit. */
  const strokeTo = (name: string, params: unknown, pts: Point[], color: number): void => {
    for (const [x, y] of pts) if (x >= 0 && y >= 0 && x < sprite.width && y < sprite.height) overlay.current.set(y * sprite.width + x, color)
    setOverlayTick((n) => n + 1)
    pending.current++
    void p.run(name, params).then((rev) => {
      pending.current--
      if (typeof rev === 'number') settleRev.current = Math.max(settleRev.current, rev)
      settle()
    })
  }

  const toCanvas = (f: number): HTMLCanvasElement => {
    const bm = renderFrame(project, sprite, f)
    const c = document.createElement('canvas')
    c.width = bm.width
    c.height = bm.height
    c.getContext('2d')?.putImageData(new ImageData(bm.data as Uint8ClampedArray<ArrayBuffer>, bm.width, bm.height), 0, 0)
    return c
  }
  const onionLayers = useMemo(() => {
    if (!p.onion || sprite.frames.length < 2) return []
    const n = sprite.frames.length
    const cur = Math.min(frame, n - 1)
    const out: Array<{ c: HTMLCanvasElement; alpha: number; tint: string }> = []
    if (cur > 0) out.push({ c: toCanvas(cur - 1), alpha: 0.6, tint: 'rgba(235,50,50,0.8)' })
    if (cur < n - 1) out.push({ c: toCanvas(cur + 1), alpha: 0.6, tint: 'rgba(40,120,255,0.8)' })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, sprite, frame, p.onion])

  const base = useMemo(() => {
    const bm = renderFrame(project, sprite, Math.min(frame, sprite.frames.length - 1))
    const c = document.createElement('canvas')
    c.width = bm.width
    c.height = bm.height
    c.getContext('2d')?.putImageData(new ImageData(bm.data as Uint8ClampedArray<ArrayBuffer>, bm.width, bm.height), 0, 0)
    return c
  }, [project, sprite, frame])

  useLayoutEffect(() => {
    const cv = ref.current
    const ctx = cv?.getContext('2d')
    if (!cv || !ctx) return
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, cv.width, cv.height)
    for (const o of onionLayers) {
      // draw the neighbour frame faintly, tinted so previous (red) and next (blue) are distinguishable
      const t = document.createElement('canvas')
      t.width = o.c.width
      t.height = o.c.height
      const tc = t.getContext('2d') as CanvasRenderingContext2D
      tc.drawImage(o.c, 0, 0)
      tc.globalCompositeOperation = 'source-atop'
      tc.fillStyle = o.tint
      tc.fillRect(0, 0, t.width, t.height)
      ctx.globalAlpha = o.alpha
      ctx.drawImage(t, 0, 0, sprite.width * zoom, sprite.height * zoom)
      ctx.globalAlpha = 1
    }
    ctx.drawImage(base, 0, 0, sprite.width * zoom, sprite.height * zoom)
    if (overlay.current.size && layer?.visible !== false) {
      const pal = project.palettes[sprite.palette]
      for (const [i, c] of overlay.current) {
        const x = (i % sprite.width) * zoom
        const y = Math.floor(i / sprite.width) * zoom
        if (c === 0) ctx.clearRect(x, y, zoom, zoom)
        else {
          const [r, g, b] = parseColor(pal?.colors[c] ?? '#ffffff')
          ctx.fillStyle = `rgb(${r},${g},${b})`
          ctx.fillRect(x, y, zoom, zoom)
        }
      }
    }
    if (shape) {
      const pal = project.palettes[sprite.palette]
      const hex = pal?.colors[p.color] ?? '#ffffff'
      const [r, g, b] = p.color === 0 ? [255, 255, 255] : parseColor(hex)
      ctx.fillStyle = `rgba(${r},${g},${b},0.85)`
      for (const [x, y] of shapePoints(shape, p.filled)) {
        if (x >= 0 && y >= 0 && x < sprite.width && y < sprite.height) ctx.fillRect(x * zoom, y * zoom, zoom, zoom)
      }
    }
    if (p.grid && zoom >= 6) {
      // 'difference' inverts whatever is underneath, so the grid reads on dark and light pixels alike.
      ctx.save()
      ctx.globalCompositeOperation = 'difference'
      ctx.lineWidth = 1
      const W = Math.round(sprite.width * zoom)
      const H = Math.round(sprite.height * zoom)
      const tw = sprite.tileSize?.w ?? 8
      const th = sprite.tileSize?.h ?? 8
      // One path per line weight (major = tile boundary) instead of one stroke per line.
      const major = new Path2D()
      const minor = new Path2D()
      for (let x = 0; x <= sprite.width; x++) {
        const gx = Math.round(x * zoom) + 0.5
        const path = x % tw === 0 ? major : minor
        path.moveTo(gx, 0)
        path.lineTo(gx, H)
      }
      for (let y = 0; y <= sprite.height; y++) {
        const gy = Math.round(y * zoom) + 0.5
        const path = y % th === 0 ? major : minor
        path.moveTo(0, gy)
        path.lineTo(W, gy)
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.38)'
      ctx.stroke(minor)
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'
      ctx.stroke(major)
      ctx.restore()
    }
    const sel = marquee ? normalize(marquee.start, marquee.cur) : p.selection
    if (sel) {
      const ox = moveOffset ? moveOffset[0] : 0
      const oy = moveOffset ? moveOffset[1] : 0
      const x = Math.round((sel.x + ox) * zoom) + 0.5
      const y = Math.round((sel.y + oy) * zoom) + 0.5
      const w = Math.round(sel.w * zoom) - 1
      const h = Math.round(sel.h * zoom) - 1
      ctx.save()
      ctx.lineWidth = 1
      ctx.strokeStyle = 'rgba(0,0,0,0.9)'
      ctx.strokeRect(x, y, w, h)
      ctx.strokeStyle = 'rgba(255,255,255,0.95)'
      ctx.setLineDash([4, 4])
      ctx.strokeRect(x, y, w, h)
      ctx.fillStyle = 'rgba(109,140,255,0.12)'
      ctx.fillRect(x, y, w, h)
      ctx.restore()
    }
  }, [base, onionLayers, shape, marquee, p.selection, moveOffset, zoom, p.grid, p.color, p.filled, project, sprite, overlayTick])

  const pixelAt = (e: React.PointerEvent): Point => {
    const r = (ref.current as HTMLCanvasElement).getBoundingClientRect()
    return [Math.floor((e.clientX - r.left) / zoom), Math.floor((e.clientY - r.top) / zoom)]
  }
  const inside = ([x, y]: Point): boolean => x >= 0 && y >= 0 && x < sprite.width && y < sprite.height
  const clamp = ([x, y]: Point): Point => [Math.min(sprite.width - 1, Math.max(0, x)), Math.min(sprite.height - 1, Math.max(0, y))]
  const target = { layer: p.layerIndex, frame }
  const inSel = (pt: Point): boolean => !!p.selection && pt[0] >= p.selection.x && pt[1] >= p.selection.y && pt[0] < p.selection.x + p.selection.w && pt[1] < p.selection.y + p.selection.h

  const onDown = (e: React.PointerEvent): void => {
    if (e.button !== 0 || p.panMode) return
    const pt = pixelAt(e)
    if (!inside(pt)) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    if (p.tool === 'picker') {
      if (cel) p.onPick(cel[pt[1] * sprite.width + pt[0]] as number)
    } else if (p.tool === 'fill') {
      void p.run('fill', { x: pt[0], y: pt[1], color: p.color, ...target })
    } else if (p.tool === 'pencil' || p.tool === 'eraser') {
      p.begin(p.tool)
      drawing.current = { last: pt }
      const c = p.tool === 'eraser' ? 0 : p.color
      strokeTo('draw_pixels', { pixels: [{ x: pt[0], y: pt[1], color: c }], ...target }, [pt], c)
    } else if (p.tool === 'line' || p.tool === 'rect' || p.tool === 'ellipse') {
      setShape({ tool: p.tool, start: pt, cur: pt })
    } else if (p.tool === 'select') {
      if (p.selection && inSel(pt)) {
        moving.current = { start: pt, last: pt, sel: p.selection }
        setMoveOffset([0, 0])
      } else {
        setMarquee({ start: pt, cur: pt })
      }
    }
  }

  const onMove = (e: React.PointerEvent): void => {
    const pt = pixelAt(e)
    p.onHover(inside(pt) ? pt : null)
    if (drawing.current && (p.tool === 'pencil' || p.tool === 'eraser')) {
      const last = drawing.current.last
      if (pt[0] === last[0] && pt[1] === last[1]) return
      const c = clamp(pt)
      const col = p.tool === 'eraser' ? 0 : p.color
      strokeTo('draw_line', { x0: last[0], y0: last[1], x1: c[0], y1: c[1], color: col, ...target }, linePoints(last[0], last[1], c[0], c[1]), col)
      drawing.current = { last: c }
    } else if (shape) {
      setShape({ ...shape, cur: clamp(pt) })
    } else if (marquee) {
      setMarquee({ ...marquee, cur: clamp(pt) })
    } else if (moving.current) {
      setMoveOffset([pt[0] - moving.current.start[0], pt[1] - moving.current.start[1]])
    }
  }

  const onUp = (): void => {
    if (drawing.current) {
      drawing.current = null
      p.end()
      settle()
    }
    if (shape) {
      const { name, params } = shapeParams(shape, p.color, p.filled, p.layerIndex, frame)
      void p.run(name, params)
      setShape(null)
    }
    if (marquee) {
      const n = normalize(marquee.start, marquee.cur)
      p.onSelection(n.w > 0 && n.h > 0 ? n : null)
      setMarquee(null)
    }
    if (moving.current) {
      const m = moving.current
      moving.current = null
      const off = moveOffset ?? [0, 0]
      setMoveOffset(null)
      if (off[0] !== 0 || off[1] !== 0) {
        void p.run('move_region', { x: m.sel.x, y: m.sel.y, width: m.sel.w, height: m.sel.h, dx: off[0], dy: off[1], ...target })
        p.onSelection({ ...m.sel, x: m.sel.x + off[0], y: m.sel.y + off[1] })
      }
    }
  }

  return (
    <div className="canvas-frame" style={{ width: Math.round(sprite.width * zoom), height: Math.round(sprite.height * zoom) }}>
      <canvas
        ref={ref}
        width={Math.round(sprite.width * zoom)}
        height={Math.round(sprite.height * zoom)}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => p.onHover(null)}
        style={{ cursor: p.panMode ? 'grab' : p.tool === 'picker' ? 'copy' : p.tool === 'select' ? 'cell' : 'crosshair' }}
      />
    </div>
  )
}
