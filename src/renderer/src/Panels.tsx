import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LogEntry } from '../../core/engine'
import { PRESET_NAMES } from '../../core/palettes'
import { renderFrame } from '../../core/render'
import type { Project, Sprite } from '../../core/types'
import { Float } from './Float'
import { Icons } from './Icons'
import { targetIndex, useReorder } from './useReorder'

type Run = (name: string, params: unknown) => Promise<void>
const isTransparent = (hex: string): boolean => hex.length === 9 && hex.endsWith('00')

function paint(cv: HTMLCanvasElement | null, project: Project, sprite: Sprite, frame: number): void {
  const ctx = cv?.getContext('2d')
  if (!cv || !ctx) return
  const bm = renderFrame(project, sprite, frame)
  const tmp = document.createElement('canvas')
  tmp.width = bm.width
  tmp.height = bm.height
  tmp.getContext('2d')?.putImageData(new ImageData(bm.data as Uint8ClampedArray<ArrayBuffer>, bm.width, bm.height), 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, cv.width, cv.height)
  const s = Math.min(cv.width / bm.width, cv.height / bm.height)
  const w = bm.width * s
  const h = bm.height * s
  ctx.drawImage(tmp, (cv.width - w) / 2, (cv.height - h) / 2, w, h)
}

function Thumb(p: { project: Project; sprite: Sprite; frame: number; size: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => paint(ref.current, p.project, p.sprite, p.frame), [p.project, p.sprite, p.frame])
  return <canvas ref={ref} width={p.size} height={p.size} />
}

export function ColorsSection(p: { project: Project; sprite: Sprite; color: number; onPick: (i: number) => void }) {
  const pal = p.project.palettes[p.sprite.palette]
  if (!pal) return null
  const hex = pal.colors[p.color] ?? '#00000000'
  // Base colours first, then each named group (e.g. colours added from an imported picture).
  const groups = [...(pal.groups ?? [])].sort((a, b) => a.from - b.from)
  const segments: Array<{ name?: string; from: number; to: number }> = []
  let cursor = 0
  for (const g of groups) {
    if (g.from > cursor) segments.push({ from: cursor, to: g.from - 1 })
    segments.push(g)
    cursor = g.to + 1
  }
  if (cursor < pal.colors.length) segments.push({ from: cursor, to: pal.colors.length - 1 })
  return (
    <div className="section">
      <h4>
        <span>{pal.name}</span>
        <span className="mono" style={{ fontWeight: 400 }}>
          idx {p.color} · {p.color === 0 ? 'transparent' : hex.slice(0, 7)}
        </span>
      </h4>
      {segments.map((seg) => (
        <div key={seg.name ?? 'base'} className="pal-group">
          {seg.name && <div className="pal-group-name">{seg.name} <span className="hint">· {seg.from}–{seg.to}</span></div>}
          <div className="swatches">
            {pal.colors.slice(seg.from, seg.to + 1).map((c, k) => {
              const i = seg.from + k
              return (
                <button
                  key={i}
                  className={'swatch' + (i === p.color ? ' active' : '') + (isTransparent(c) ? ' clear' : '')}
                  style={isTransparent(c) ? undefined : { background: c }}
                  title={i === 0 ? '0: transparent (erases)' : `${i}: ${c}`}
                  aria-label={i === 0 ? 'Transparent' : `Color ${i} ${c}`}
                  onClick={() => p.onPick(i)}
                />
              )
            })}
          </div>
        </div>
      ))}
      <div className="current">
        <div className={'big' + (p.color === 0 ? ' swatch clear' : '')} style={p.color === 0 ? undefined : { background: hex }} />
        <span className="meta">{pal.colors.length - 1} colors</span>
      </div>
    </div>
  )
}

export function LayersSection(p: { sprite: Sprite; layerIndex: number; onSelect: (i: number) => void; run: Run; begin: (l: string) => void; end: () => void }) {
  const rows = p.sprite.layers.map((l, i) => ({ l, i })).reverse()
  const cur = p.sprite.layers[p.layerIndex]
  const n = p.sprite.layers.length
  const onMove = useCallback(
    (fromRow: number, insertAt: number) => {
      const toRow = targetIndex(fromRow, insertAt)
      const layer = n - 1 - fromRow
      const to = n - 1 - toRow
      void p.run('layer_move', { layer, to })
      p.onSelect(to)
    },
    [n, p.run, p.onSelect]
  )
  const drag = useReorder({ axis: 'y', itemSelector: 'li.layer-row', onMove })
  const [editing, setEditing] = useState<string | null>(null)
  const dragging = drag.state ? rows[drag.state.from] : undefined
  return (
    <div className="section">
      <h4>
        <span>Layers</span>
        <span className="row-actions">
          <button className="mini" aria-label="Delete layer" title="Delete layer" disabled={n < 2} onClick={() => { void p.run('layer_delete', { layer: p.layerIndex }); p.onSelect(Math.max(0, p.layerIndex - 1)) }}>✕</button>
          <button className="mini" onClick={() => { void p.run('layer_add', {}); p.onSelect(n) }}>+ Add</button>
        </span>
      </h4>
      <ul className={'list' + (drag.state ? ' reordering' : '')} ref={(el) => { drag.containerRef.current = el }}>
        {rows.map(({ l, i }, row) => (
          <li
            key={l.id}
            className={'layer-row' + (i === p.layerIndex ? ' active' : '') + (drag.state?.from === row ? ' lifted' : '') + (drag.state?.drop === row ? ' drop-before' : '') + (drag.state && drag.state.drop === rows.length && row === rows.length - 1 ? ' drop-after' : '')}
            onClick={() => p.onSelect(i)}
            onPointerDown={(e) => drag.onPointerDown(e, row)}
            title="Drag to reorder"
          >
            <button
              aria-label={l.visible ? `Hide ${l.name}` : `Show ${l.name}`}
              className={l.visible ? '' : 'dimmed'}
              onClick={(e) => {
                e.stopPropagation()
                void p.run('layer_set', { layer: i, visible: !l.visible })
              }}
            >
              {l.visible ? Icons['eye'] : Icons['eyeOff']}
            </button>
            {editing === l.id ? (
              <input
                className="layer-name"
                defaultValue={l.name}
                autoFocus
                aria-label={`Layer name: ${l.name}`}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  if (v && v !== l.name) void p.run('layer_set', { layer: i, name: v })
                  setEditing(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setEditing(null)
                }}
              />
            ) : (
              <span className={'layer-name' + (l.visible ? '' : ' dimmed')} title="Double-click to rename" onDoubleClick={() => setEditing(l.id)}>
                {l.name}
              </span>
            )}
            <span className="hint">{Math.round(l.opacity * 100)}%</span>
          </li>
        ))}
      </ul>
      {drag.state &&
        dragging &&
        createPortal(
          <div className="drag-ghost layer-ghost" style={{ left: drag.state.ghost.x - drag.state.ghost.dx, top: drag.state.ghost.y - drag.state.ghost.dy }}>
            {dragging.l.visible ? Icons['eye'] : Icons['eyeOff']}
            <span>{dragging.l.name}</span>
          </div>,
          document.body
        )}
      {cur && (
        <label className="opacity">
          <span className="hint">Opacity</span>
          <input
            type="range"
            min={0}
            max={100}
            key={cur.id}
            defaultValue={Math.round(cur.opacity * 100)}
            aria-label={`Opacity of ${cur.name}`}
            onPointerDown={() => p.begin('opacity')}
            onPointerUp={p.end}
            onChange={(e) => void p.run('layer_set', { layer: p.layerIndex, opacity: Number(e.target.value) / 100 })}
          />
        </label>
      )}
    </div>
  )
}

export function Timeline(p: { project: Project; sprite: Sprite; frame: number; onSelect: (i: number) => void; run: Run }) {
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [tagOpen, setTagOpen] = useState(false)
  const [tagName, setTagName] = useState('idle')
  const [tagFrom, setTagFrom] = useState(0)
  const [tagTo, setTagTo] = useState(0)
  const n = p.sprite.frames.length
  const tag = p.sprite.tags.find((t) => p.frame >= t.from && p.frame <= t.to)
  // Play advances the real current frame, so the canvas (and onion skin) animate too.
  // It loops the current tag when there is one, otherwise all frames.
  const loopFrom = tag ? tag.from : 0
  const loopTo = tag ? tag.to : n - 1
  useEffect(() => {
    if (!playing || n < 2) return
    const cur = Math.min(Math.max(p.frame, loopFrom), loopTo)
    const dur = (p.sprite.frames[cur]?.duration ?? 100) / speed
    const t = setTimeout(() => p.onSelect(cur >= loopTo ? loopFrom : cur + 1), dur)
    return () => clearTimeout(t)
  }, [playing, p.frame, n, p.sprite, speed, loopFrom, loopTo, p.onSelect])
  const shown = p.frame
  const f = p.sprite.frames[p.frame]
  const framesRef = useRef<HTMLDivElement | null>(null)
  const onFrameMove = useCallback(
    (from: number, insertAt: number) => {
      const to = targetIndex(from, insertAt)
      void p.run('frame_move', { from, to })
      p.onSelect(to)
    },
    [p.run, p.onSelect]
  )
  const fdrag = useReorder({ axis: 'x', itemSelector: '.frame:not(.add)', onMove: onFrameMove })
  useEffect(() => {
    const el = framesRef.current?.querySelector('[data-active]') as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [shown, n])
  const openTagEditor = (): void => {
    setTagName(tag?.name ?? (p.sprite.tags.length ? `tag${p.sprite.tags.length + 1}` : 'idle'))
    setTagFrom(tag?.from ?? p.frame)
    setTagTo(tag?.to ?? p.frame)
    setTagOpen(true)
  }
  return (
    <Float id="timeline" className="timeline">
      <button className="play" aria-label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying(!playing)} disabled={n < 2}>
        {playing ? Icons['pause'] : Icons['play']}
      </button>
      <select className="speed" value={speed} aria-label="Playback speed" onChange={(e) => setSpeed(Number(e.target.value))}>
        <option value={0.25}>¼×</option>
        <option value={0.5}>½×</option>
        <option value={1}>1×</option>
        <option value={2}>2×</option>
      </select>
      <div className={'frames' + (fdrag.state ? ' reordering' : '')} ref={(el) => { framesRef.current = el; fdrag.containerRef.current = el }}>
        {p.sprite.frames.map((fr, i) => (
          <button
            key={fr.id}
            className={'frame' + (i === shown ? ' active' : '') + (fdrag.state?.from === i ? ' lifted' : '') + (fdrag.state?.drop === i ? ' drop-before' : '') + (fdrag.state && fdrag.state.drop === n && i === n - 1 ? ' drop-after' : '')}
            onClick={() => p.onSelect(i)}
            onPointerDown={(e) => fdrag.onPointerDown(e, i)}
            aria-label={`Frame ${i}`}
            title="Drag to reorder"
            data-active={i === shown || undefined}
          >
            <Thumb project={p.project} sprite={p.sprite} frame={i} size={56} />
            <span>{i}</span>
          </button>
        ))}
        <button className="frame add" aria-label="Add frame (copy of current)" title="Add frame (copy of current)" onClick={() => void p.run('frame_add', { copyFrom: p.frame })}>
          +
        </button>
      </div>
      <div className="frame-ops">
        <button className="mini" aria-label="Delete frame" title="Delete frame" disabled={n < 2} onClick={() => { void p.run('frame_delete', { frame: p.frame }); p.onSelect(Math.max(0, p.frame - 1)) }}>✕</button>
      </div>
      {fdrag.state &&
        createPortal(
          <div className="drag-ghost frame-ghost" style={{ left: fdrag.state.ghost.x - fdrag.state.ghost.dx, top: fdrag.state.ghost.y - fdrag.state.ghost.dy }}>
            <Thumb project={p.project} sprite={p.sprite} frame={fdrag.state.from} size={56} />
            <span>{fdrag.state.from}</span>
          </div>,
          document.body
        )}
      <div className="vr" />
      <div className="stat">
        <small>tag</small>
        <button className="linkish" onClick={openTagEditor} title="Edit tags">{tag ? `${tag.name} · ${tag.from}–${tag.to}` : '+ tag'}</button>
      </div>
      {f && (
        <div className="stat">
          <small>frame {p.frame}</small>
          <input
            key={f.id + f.duration}
            className="mono"
            type="number"
            min={10}
            max={10000}
            step={10}
            defaultValue={f.duration}
            aria-label="Frame duration in milliseconds"
            onBlur={(e) => {
              const v = Math.round(Number(e.target.value))
              if (v >= 10 && v !== f.duration) void p.run('frame_set_duration', { frame: p.frame, duration: v })
            }}
          />
        </div>
      )}
      {tagOpen && (
        <div className="tag-editor" role="dialog" aria-label="Tags">
          <form
            className="tag-form"
            onSubmit={(e) => {
              e.preventDefault()
              void p.run('tag_add', { name: tagName.trim(), from: Math.min(tagFrom, tagTo), to: Math.max(tagFrom, tagTo) })
              setTagOpen(false)
            }}
          >
            <label>Name <input value={tagName} onChange={(e) => setTagName(e.target.value)} required maxLength={40} /></label>
            <label>From <input type="number" min={0} max={n - 1} value={tagFrom} onChange={(e) => setTagFrom(Number(e.target.value))} /></label>
            <label>To <input type="number" min={0} max={n - 1} value={tagTo} onChange={(e) => setTagTo(Number(e.target.value))} /></label>
            <button type="submit" className="mini" style={{ background: 'var(--accent)', color: 'var(--accent-text)' }}>Save tag</button>
            <button type="button" className="mini" onClick={() => setTagOpen(false)}>Close</button>
          </form>
          {p.sprite.tags.length > 0 && (
            <ul className="list">
              {p.sprite.tags.map((t) => (
                <li key={t.name} onClick={() => p.onSelect(t.from)}>
                  <span style={{ flex: 1 }}>{t.name} <span className="hint">· {t.from}–{t.to}</span></span>
                  <button className="mini" aria-label={`Remove tag ${t.name}`} onClick={(e) => { e.stopPropagation(); void p.run('tag_remove', { name: t.name }) }}>✕</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Float>
  )
}

const ACTOR_LABEL: Record<LogEntry['actor'], string> = { human: 'you', agent: 'agent', system: 'app' }

export function AgentPanel(p: { log: LogEntry[]; mcpUrl: string | null; onUndo: () => void; canUndo: boolean }) {
  const [open, setOpen] = useState(true)
  const [copied, setCopied] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [p.log.length, open])
  const rows = useMemo(() => {
    const out: Array<{ entry: LogEntry; count: number }> = []
    for (const e of p.log) {
      const last = out[out.length - 1]
      if (last && last.entry.group === e.group && last.entry.actor === e.actor && e.command !== 'undo' && e.command !== 'redo') {
        last.count++
        last.entry = e
      } else out.push({ entry: e, count: 1 })
    }
    return out
  }, [p.log])
  const agentSteps = p.log.filter((e) => e.actor === 'agent').length
  const copy = async (): Promise<void> => {
    if (!p.mcpUrl) return
    await navigator.clipboard.writeText(p.mcpUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <Float id="agent" className="agent-panel">
      <header>
        <span className={'dot' + (p.mcpUrl ? '' : ' off')} />
        <span>Agent</span>
        <small>{agentSteps ? `${agentSteps} steps` : p.mcpUrl ? 'waiting for a connection' : 'server off'}</small>
        <button className="toggle" aria-label={open ? 'Collapse' : 'Expand'} onClick={() => setOpen(!open)}>
          {open ? Icons['minus'] : Icons['plus']}
        </button>
      </header>
      {open && (
        <>
          <div className="activity">
            {rows.length === 0 && <div className="hint">Edits by you and by connected agents appear here.</div>}
            {rows.map(({ entry, count }) => (
              <div key={entry.seq} className={'log ' + entry.actor}>
                <span className="badge">{ACTOR_LABEL[entry.actor]}</span>
                <span className="msg">{count > 1 ? `${count} edits · ${entry.summary}` : entry.summary}</span>
              </div>
            ))}
            <div ref={endRef} />
          </div>
          <footer>
            {p.mcpUrl ? (
              <>
                <code className="mono" title={p.mcpUrl}>{p.mcpUrl}</code>
                <button className="mini" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
              </>
            ) : (
              <span className="hint">Agent server is not running</span>
            )}
            <button className="mini" onClick={p.onUndo} disabled={!p.canUndo}>Undo last</button>
          </footer>
        </>
      )}
    </Float>
  )
}

export function NewSpriteForm(p: { run: Run; onDone?: () => void; onCancel?: () => void }) {
  const [kind, setKind] = useState<'sprite' | 'tileset'>('sprite')
  const [name, setName] = useState('Sprite')
  const [w, setW] = useState(32)
  const [h, setH] = useState(32)
  const [tw, setTw] = useState(16)
  const [th, setTh] = useState(16)
  const [cols, setCols] = useState(8)
  const [rows, setRows] = useState(4)
  const [palette, setPalette] = useState('db16')
  const num = (v: string, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Number(v) || lo))
  return (
    <form
      className="newsprite"
      onSubmit={(e) => {
        e.preventDefault()
        const cmd =
          kind === 'tileset'
            ? p.run('tileset_create', { name, tileWidth: tw, tileHeight: th, columns: cols, rows, palette })
            : p.run('sprite_create', { name, width: w, height: h, palette })
        void cmd.then(p.onDone)
      }}
    >
      <label>Kind
        <select value={kind} onChange={(e) => { setKind(e.target.value as 'sprite' | 'tileset'); if (e.target.value === 'tileset' && name === 'Sprite') setName('Tileset') }}>
          <option value="sprite">Sprite</option>
          <option value="tileset">Tileset</option>
        </select>
      </label>
      <label>Name <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></label>
      {kind === 'sprite' ? (
        <>
          <label>Width <input type="number" min={1} max={512} value={w} onChange={(e) => setW(num(e.target.value, 1, 512))} /></label>
          <label>Height <input type="number" min={1} max={512} value={h} onChange={(e) => setH(num(e.target.value, 1, 512))} /></label>
        </>
      ) : (
        <>
          <label>Tile width <input type="number" min={1} max={128} value={tw} onChange={(e) => setTw(num(e.target.value, 1, 128))} /></label>
          <label>Tile height <input type="number" min={1} max={128} value={th} onChange={(e) => setTh(num(e.target.value, 1, 128))} /></label>
          <label>Columns <input type="number" min={1} max={64} value={cols} onChange={(e) => setCols(num(e.target.value, 1, 64))} /></label>
          <label>Rows <input type="number" min={1} max={64} value={rows} onChange={(e) => setRows(num(e.target.value, 1, 64))} /></label>
          <span className="hint wide">{cols * tw}×{rows * th} px, {cols * rows} tiles</span>
        </>
      )}
      <label className="wide">
        Palette
        <select value={palette} onChange={(e) => setPalette(e.target.value)}>
          {PRESET_NAMES.map((n) => <option key={n}>{n}</option>)}
        </select>
      </label>
      <div className="actions">
        {p.onCancel && <button type="button" className="mini" onClick={p.onCancel}>Cancel</button>}
        <button type="submit" className="mini" style={{ background: 'var(--accent)', color: 'var(--accent-text)' }}>Create</button>
      </div>
    </form>
  )
}
