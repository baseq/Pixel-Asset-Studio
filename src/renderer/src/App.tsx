import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { EngineState } from '../../core/engine'
import type { Point } from '../../core/geometry'
import type { AppInfo, PickedImage } from '../../shared/api'
import { Canvas, type Selection, type Tool } from './Canvas'
import { Icons } from './Icons'
import { Float } from './Float'
import { ImportDialog } from './ImportDialog'
import { AgentPanel, ColorsSection, LayersSection, NewSpriteForm, Timeline } from './Panels'
import { useTheme, type ThemePref } from './theme'

const TOOLS: Array<{ id: Tool; label: string; key: string }> = [
  { id: 'hand', label: 'Hand: drag to explore', key: 'h' },
  { id: 'pencil', label: 'Pencil', key: 'b' },
  { id: 'eraser', label: 'Eraser', key: 'e' },
  { id: 'line', label: 'Line', key: 'l' },
  { id: 'rect', label: 'Rectangle', key: 'r' },
  { id: 'ellipse', label: 'Ellipse', key: 'o' },
  { id: 'fill', label: 'Fill', key: 'g' },
  { id: 'picker', label: 'Picker', key: 'i' },
  { id: 'select', label: 'Select (drag inside to move, Delete to clear)', key: 'm' }
]

const THEMES: Array<{ id: ThemePref; label: string; icon: string }> = [
  { id: 'system', label: 'System theme', icon: 'monitor' },
  { id: 'light', label: 'Light theme', icon: 'sun' },
  { id: 'dark', label: 'Dark theme', icon: 'moon' }
]

export function App() {
  const [state, setState] = useState<EngineState | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [theme, setTheme] = useTheme()
  const [tool, setTool] = useState<Tool>('hand')
  const [color, setColor] = useState(1)
  const [zoom, setZoom] = useState(16)
  const [frame, setFrame] = useState(0)
  const [layerIndex, setLayerIndex] = useState(0)
  const [filled, setFilled] = useState(false)
  const [grid, setGrid] = useState(true)
  const [hover, setHover] = useState<Point | null>(null)
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'info' } | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [importing, setImporting] = useState<PickedImage | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [onion, setOnion] = useState(false)
  const [selection, setSelection] = useState<Selection | null>(null)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const stageRef = useRef<HTMLDivElement>(null)
  const [panning, setPanning] = useState(false)
  const spaceDown = useRef(false)
  const drag = useRef<{ x: number; y: number; sl: number; st: number } | null>(null)
  const zoomF = useRef(16)
  const selRef = useRef<Selection | null>(null)
  const layerRef = useRef(0)
  const frameRef = useRef(0)

  // Zoom around a point: remember which sprite pixel is under the cursor, then after React has
  // re-laid out the bigger/smaller canvas, scroll so that pixel is back under the cursor.
  const anchor = useRef<{ px: number; py: number; clientX: number; clientY: number } | null>(null)
  const zoomAt = useCallback((next: number, clientX?: number, clientY?: number) => {
    const el = stageRef.current
    // Fractional zoom, so pinch moves smoothly instead of hopping a whole 100% at a time.
    zoomF.current = Math.max(1, Math.min(64, next))
    const z = Math.round(zoomF.current * 100) / 100
    setZoom((prev) => {
      if (!el || z === prev) return prev
      const frame = el.querySelector('.canvas-frame') as HTMLElement | null
      if (frame) {
        const r = frame.getBoundingClientRect()
        const sr = el.getBoundingClientRect()
        const cx = clientX ?? sr.left + sr.width / 2
        const cy = clientY ?? sr.top + sr.height / 2
        anchor.current = { px: (cx - r.left) / prev, py: (cy - r.top) / prev, clientX: cx, clientY: cy }
      }
      return z
    })
  }, [])
  // Centre the canvas when a sprite first appears or another sprite is selected.
  const spriteKey = state?.project.activeSprite ?? state?.project.sprites[0]?.id ?? null
  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el || !spriteKey) return
    el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2
    el.scrollTop = (el.scrollHeight - el.clientHeight) / 2
  }, [spriteKey])

  useLayoutEffect(() => {
    const el = stageRef.current
    const a = anchor.current
    anchor.current = null
    const frame = el?.querySelector('.canvas-frame') as HTMLElement | null
    if (!el || !a || !frame) return
    const r = frame.getBoundingClientRect()
    el.scrollLeft += r.left + a.px * zoom - a.clientX
    el.scrollTop += r.top + a.py * zoom - a.clientY
  }, [zoom])

  // ⌘/Ctrl + wheel (and trackpad pinch, which browsers report as ctrl+wheel) zooms at the cursor.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      // Two-finger scroll never moves the canvas: exploring is done by dragging with the
      // hand tool, Space+drag or the middle mouse button. Pinch (ctrl+wheel) and ⌘+wheel zoom.
      e.preventDefault()
      if (!(e.ctrlKey || e.metaKey)) return
      // Pinch arrives as many small ctrl+wheel events: accumulate on a float so every
      // step counts, and only re-render when the integer zoom actually changes.
      // Gentle: per-event change capped at ±5%; zoom is fractional so every tick shows.
      const factor = Math.max(0.95, Math.min(1.05, Math.exp(-e.deltaY * 0.004)))
      zoomAt(zoomF.current * factor, e.clientX, e.clientY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt, state === null])

  const fitToWindow = useCallback(() => {
    const el = stageRef.current
    const sp = state?.project.sprites.find((s) => s.id === state.project.activeSprite) ?? state?.project.sprites[0]
    if (!el || !sp) return
    const z = Math.max(1, Math.floor(Math.min((el.clientWidth - 440) / sp.width, (el.clientHeight - 260) / sp.height)))
    zoomF.current = z
    setZoom(z)
    requestAnimationFrame(() => {
      el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2
      el.scrollTop = (el.scrollHeight - el.clientHeight) / 2
    })
  }, [state])

  const onStagePointerDown = (e: React.PointerEvent): void => {
    const el = stageRef.current
    if (!el) return
    if (e.button === 1 || (e.button === 0 && (spaceDown.current || tool === 'hand'))) {
      e.preventDefault()
      drag.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop }
      setPanning(true)
      el.setPointerCapture(e.pointerId)
    }
  }
  const onStagePointerMove = (e: React.PointerEvent): void => {
    const el = stageRef.current
    const d = drag.current
    if (!el || !d) return
    el.scrollLeft = d.sl - (e.clientX - d.x)
    el.scrollTop = d.st - (e.clientY - d.y)
  }
  const onStagePointerUp = (): void => {
    drag.current = null
    setPanning(false)
  }

  useEffect(() => {
    void window.pas.getState().then(setState)
    void window.pas.getInfo().then(setInfo)
    return window.pas.onState(setState)
  }, [])

  // Commands are sent one at a time so a fast stroke is applied in order.
  // Resolves to the engine revision the command produced, or null if it failed.
  const run = useCallback((name: string, params: unknown): Promise<number | null> => {
    const next = queue.current.then(async () => {
      const r = await window.pas.command(name, params)
      if (!r.ok) {
        setNotice({ text: r.error, kind: 'error' })
        return null
      }
      return r.revision ?? null
    })
    queue.current = next.then(() => undefined, () => undefined)
    return next
  }, [])
  const begin = useCallback((label: string) => void (queue.current = queue.current.then(() => window.pas.beginGroup(label))), [])
  const end = useCallback(() => void (queue.current = queue.current.then(() => window.pas.endGroup())), [])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 5000)
    return () => clearTimeout(t)
  }, [notice])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement
      const typing = (el instanceof HTMLInputElement && el.type !== 'checkbox') || el.tagName === 'SELECT'
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.code === 'Space') {
        e.preventDefault()
        spaceDown.current = true
        setPanning(true)
        return
      }
      const t = TOOLS.find((x) => x.key === e.key.toLowerCase())
      if (t) setTool(t.id)
      if (e.key === 'Escape') setSelection(null)
      if ((e.key === 'Delete' || e.key === 'Backspace') && selRef.current) {
        const s = selRef.current
        void run('clear_region', { x: s.x, y: s.y, width: s.w, height: s.h, layer: layerRef.current, frame: frameRef.current })
      }
      if (e.key === '+' || e.key === '=') zoomAt(zoomF.current * 1.25)
      if (e.key === '-') zoomAt(zoomF.current / 1.25)
      if (e.key === '0') fitToWindow()
      if (e.key === '1') zoomAt(1)
    }
    const onUp = (e: KeyboardEvent): void => {
      if (e.code === 'Space') {
        spaceDown.current = false
        if (!drag.current) setPanning(false)
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onUp)
    }
  }, [zoomAt, fitToWindow, run])

  if (!state) return <div className="loading">Loading…</div>
  const { project } = state
  const sprite = project.sprites.find((s) => s.id === project.activeSprite) ?? project.sprites[0]

  // Keep selections valid when an agent (or undo) changes the sprite underneath us.
  const safeFrame = sprite ? Math.min(frame, sprite.frames.length - 1) : 0
  const safeLayer = sprite ? Math.min(layerIndex, sprite.layers.length - 1) : 0
  const palSize = sprite ? (project.palettes[sprite.palette]?.colors.length ?? 1) : 1
  const safeColor = Math.min(color, palSize - 1)
  selRef.current = selection
  layerRef.current = safeLayer
  frameRef.current = safeFrame

  const pickImage = async (): Promise<void> => {
    try {
      const img = await window.pas.pickImage()
      if (img) setImporting(img)
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : String(e), kind: 'error' })
    }
  }

  const exportAs = async (kind: 'frame' | 'sheet' | 'gif', scale = 1): Promise<void> => {
    setExportOpen(false)
    try {
      const saved = await window.pas.exportImage({ kind, format: kind === 'gif' ? 'gif' : 'png', scale, frame: safeFrame })
      if (saved) setNotice({ text: `Exported to ${saved}`, kind: 'info' })
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : String(e), kind: 'error' })
    }
  }

  return (
    <div className="app">
      <div
        className={'stage' + (panning || tool === 'hand' ? ' panning' : '')}
        ref={stageRef}
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
        onPointerCancel={onStagePointerUp}
        onContextMenu={(e) => { if (drag.current) e.preventDefault() }}
      >
        {sprite ? (
          <div className="stage-inner">
            <Canvas
              project={project}
              revision={state.revision}
              sprite={sprite}
              frame={safeFrame}
              layerIndex={safeLayer}
              zoom={zoom}
              tool={tool}
              color={safeColor}
              filled={filled}
              grid={grid}
              onion={onion}
              panMode={panning || tool === 'hand'}
              selection={selection}
              onSelection={setSelection}
              run={run}
              begin={begin}
              end={end}
              onPick={setColor}
              onHover={setHover}
            />
          </div>
        ) : (
          <div className="empty">
            <h2 style={{ margin: 0 }}>No sprite yet</h2>
            <div className="card"><NewSpriteForm run={run} /></div>
          </div>
        )}
      </div>

      {/* top-left: file / sprite breadcrumb */}
      <Float id="crumb" className="crumb">
        <span className="logo">{Icons['logo']}</span>
        <span className="name">{project.name}</span>
        {sprite && (
          <>
            <span className="sep">/</span>
            {project.sprites.length > 1 ? (
              <select value={sprite.id} aria-label="Active sprite" onChange={(e) => void run('sprite_select', { sprite: e.target.value })}>
                {project.sprites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            ) : (
              <span className="muted">{sprite.name}</span>
            )}
            <span className="sep">/</span>
            <span className="muted mono">{sprite.width}×{sprite.height}{sprite.tileSize ? ` · ${sprite.tileSize.w}×${sprite.tileSize.h} tiles` : ''}</span>
          </>
        )}
        <span className="sep">·</span>
        <button className="mini" onClick={() => setShowNew(!showNew)}>New</button>
        <button className="mini" onClick={() => void window.pas.openProject()}>Open</button>
        <button className="mini" onClick={() => void window.pas.saveProject()}>Save</button>
        <button className="mini" onClick={() => void pickImage()}>Import…</button>
      </Float>

      {showNew && (
        <div className="modal-backdrop" onClick={() => setShowNew(false)}>
          <div className="modal modal-sm" role="dialog" aria-label="New sprite" onClick={(e) => e.stopPropagation()}>
            <header><strong>New sprite</strong></header>
            <div className="modal-body">
              <NewSpriteForm run={run} onDone={() => setShowNew(false)} onCancel={() => setShowNew(false)} />
            </div>
          </div>
        </div>
      )}

      {/* top-right: history, zoom, theme, agent status, export */}
      <div className="topright">
        <div className="group">
          <button aria-label="Undo" title="Undo (⌘Z)" onClick={() => void window.pas.undo()} disabled={!state.canUndo}>{Icons['undo']}</button>
          <button aria-label="Redo" title="Redo (⇧⌘Z)" onClick={() => void window.pas.redo()} disabled={!state.canRedo}>{Icons['redo']}</button>
        </div>
        <div className="group">
          <button aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomAt(zoomF.current / 1.25)}>{Icons['minus']}</button>
          <button className="zoom mono" title="Fit to window (0)" onClick={fitToWindow}>{Math.round(zoom * 100)}%</button>
          <button aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomAt(zoomF.current * 1.25)}>{Icons['plus']}</button>
        </div>
        <div className="group" aria-label="View">
          {(tool === 'rect' || tool === 'ellipse') && (
            <button className={'toggle' + (filled ? ' on' : '')} aria-pressed={filled} aria-label="Filled shapes" title="Filled shapes" onClick={() => setFilled(!filled)}>{Icons['filled']}</button>
          )}
          <button className={'toggle' + (grid ? ' on' : '')} aria-pressed={grid} aria-label="Pixel grid" title="Pixel grid" onClick={() => setGrid(!grid)}>{Icons['grid']}</button>
          <button className={'toggle' + (onion ? ' on' : '')} aria-pressed={onion} aria-label="Onion skin: previous frame in red, next in blue" title="Onion skin: previous frame in red, next in blue" onClick={() => setOnion(!onion)}>{Icons['onion']}</button>
        </div>
        <div className="group" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button key={t.id} role="radio" aria-checked={theme === t.id} aria-label={t.label} title={t.label} className={theme === t.id ? 'on' : ''} onClick={() => setTheme(t.id)}>
              {Icons[t.icon]}
            </button>
          ))}
        </div>
        <div className="pill">
          <span className={'dot' + (info?.mcpUrl ? '' : ' off')} />
          <span>{info?.mcpUrl ? 'Agent' : 'No agent'}</span>
        </div>
        <div className="menu-wrap">
          <button className="primary" onClick={() => setExportOpen(!exportOpen)} disabled={!sprite} aria-haspopup="menu" aria-expanded={exportOpen}>Export ▾</button>
          {exportOpen && (
            <div className="menu" role="menu">
              <button role="menuitem" onClick={() => void exportAs('frame')}>Current frame · PNG</button>
              <button role="menuitem" onClick={() => void exportAs('frame', 4)}>Current frame · PNG 4×</button>
              <button role="menuitem" onClick={() => void exportAs('sheet')}>Sprite sheet + JSON atlas</button>
              <button role="menuitem" onClick={() => void exportAs('gif', 4)}>Animated GIF 4×</button>
              <button role="menuitem" onClick={() => void exportAs('gif', 1)}>Animated GIF 1×</button>
            </div>
          )}
        </div>
      </div>

      {/* left: tools */}
      <Float id="tools" className="tools">
        {TOOLS.map((t) => (
          <button key={t.id} className={tool === t.id ? 'active' : ''} onClick={() => setTool(t.id)} aria-label={`${t.label} (${t.key.toUpperCase()})`} title={`${t.label} (${t.key.toUpperCase()})`}>
            {Icons[t.id]}
          </button>
        ))}
      </Float>

      {/* right: inspector */}
      {sprite && (
        <Float id="inspector" className="inspector">
          <ColorsSection project={project} sprite={sprite} color={safeColor} onPick={setColor} />
          <LayersSection sprite={sprite} layerIndex={safeLayer} onSelect={setLayerIndex} run={run} begin={begin} end={end} />
        </Float>
      )}

      {/* fixed cursor readout (does not move with the image) */}
      {sprite && (
        <div className="float coords mono" aria-live="off">
          {hover ? `x ${hover[0]}  y ${hover[1]}` : `${sprite.width}×${sprite.height}`}
          <span className="sep">·</span>
          {Math.round(zoom * 100)}%
        </div>
      )}

      {/* bottom: timeline */}
      {sprite && <Timeline project={project} sprite={sprite} frame={safeFrame} onSelect={setFrame} run={run} />}

      {/* bottom-left: agent */}
      <AgentPanel log={state.log} mcpUrl={info?.mcpUrl ?? null} onUndo={() => void window.pas.undo()} canUndo={state.canUndo} />

      {importing && (
        <ImportDialog image={importing} project={project} sprite={sprite} run={run} begin={begin} end={end} onClose={() => setImporting(null)} onFrame={setFrame} />
      )}

      {notice && (
        <div className={'toast ' + notice.kind} onClick={() => setNotice(null)}>{notice.text}</div>
      )}
    </div>
  )
}
