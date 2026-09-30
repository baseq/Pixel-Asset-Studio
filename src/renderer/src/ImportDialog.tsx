import { useEffect, useMemo, useRef, useState } from 'react'
import { parseColor } from '../../core/palettes'
import { extractPalette, pixelate, type Dither, type Fit } from '../../core/pixelate'
import type { Bitmap } from '../../core/render'
import type { Project, Sprite } from '../../core/types'
import type { PickedImage } from '../../shared/api'

type Run = (name: string, params: unknown) => Promise<unknown>

interface Props {
  image: PickedImage
  project: Project
  sprite: Sprite | undefined
  run: Run
  begin: (label: string) => void
  end: () => void
  onClose: () => void
  /** Called with the index of a newly created frame so the editor can show it. */
  onFrame?: (i: number) => void
}

const fileName = (p: string): string => p.split(/[\\/]/).pop() ?? p

export function ImportDialog(p: Props) {
  const src: Bitmap = useMemo(() => ({ width: p.image.width, height: p.image.height, data: p.image.data }), [p.image])
  const aspect = src.width / src.height
  const startW = p.sprite ? p.sprite.width : Math.min(64, src.width)
  const [width, setWidth] = useState(startW)
  const [height, setHeight] = useState(p.sprite ? p.sprite.height : Math.max(1, Math.round(startW / aspect)))
  const [lockAspect, setLockAspect] = useState(!p.sprite)
  const [target, setTarget] = useState<'new' | 'frame' | 'current'>(p.sprite ? 'frame' : 'new')
  const [name, setName] = useState(fileName(p.image.path).replace(/\.[^.]+$/, ''))
  const [paletteMode, setPaletteMode] = useState<'sprite' | 'auto'>(p.sprite ? 'sprite' : 'auto')
  const [colorsDraft, setColorsDraft] = useState(16)
  const [colors, setColors] = useState(16)
  const [fit, setFit] = useState<Fit>('contain')
  const [dither, setDither] = useState<Dither>('none')
  const [cleanup, setCleanup] = useState(true)
  const [alpha, setAlpha] = useState(128)
  // The slider updates a draft while dragging; the (expensive) preview recomputes only on release.
  const [alphaDraft, setAlphaDraft] = useState(128)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const spritePalette = p.sprite ? p.project.palettes[p.sprite.palette]?.colors : undefined
  const autoPalette = useMemo(() => (paletteMode === 'auto' ? ['#00000000', ...extractPalette(src, colors, alpha)] : null), [src, colors, alpha, paletteMode])
  const usesNewSprite = target === 'new' || !p.sprite
  // Extending: existing colours stay at their indexes, new ones are appended (duplicates skipped).
  const extended = useMemo(() => {
    if (!spritePalette || !autoPalette) return null
    const have = new Set(spritePalette.map((c) => c.toLowerCase()))
    return [...spritePalette, ...autoPalette.slice(1).filter((c) => !have.has(c.toLowerCase()))]
  }, [spritePalette, autoPalette])
  const palette = paletteMode === 'auto' ? (usesNewSprite ? autoPalette : extended) : spritePalette

  const result = useMemo(() => {
    if (!palette || palette.length < 2) return null
    try {
      return pixelate(src, palette, { width, height, fit, dither, cleanup, alphaThreshold: alpha })
    } catch {
      return null
    }
  }, [src, palette, width, height, fit, dither, cleanup, alpha])

  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    const ctx = cv?.getContext('2d')
    if (!cv || !ctx || !result || !palette) return
    const rgba = new Uint8ClampedArray(width * height * 4)
    const cols = palette.map(parseColor)
    result.indexes.forEach((idx, i) => {
      const c = cols[idx]
      if (!c || idx === 0) return
      rgba.set(c, i * 4)
    })
    const tmp = document.createElement('canvas')
    tmp.width = width
    tmp.height = height
    tmp.getContext('2d')?.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0)
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, cv.width, cv.height)
    const s = Math.min(cv.width / width, cv.height / height)
    ctx.drawImage(tmp, (cv.width - width * s) / 2, (cv.height - height * s) / 2, width * s, height * s)
  }, [result, palette, width, height])

  const setW = (w: number): void => {
    w = Math.max(1, Math.min(512, w || 1))
    setWidth(w)
    if (lockAspect) setHeight(Math.max(1, Math.round(w / aspect)))
  }
  const setH = (h: number): void => {
    h = Math.max(1, Math.min(512, h || 1))
    setHeight(h)
    if (lockAspect) setWidth(Math.max(1, Math.round(h * aspect)))
  }

  const apply = async (): Promise<void> => {
    if (!result || !palette) return
    let maxIdx = 0
    for (const v of result.indexes) if (v > maxIdx) maxIdx = v
    if (maxIdx >= palette.length) {
      setError(`Internal mismatch: pixel index ${maxIdx} but the palette has ${palette.length} entries. Please report this.`)
      return
    }
    setBusy(true)
    p.begin('import image')
    try {
      let spriteRef = p.sprite?.id
      let frame: number | undefined
      if (usesNewSprite) {
        // Create the sprite with the palette the preview was quantised against, so every index fits.
        const basePalette = paletteMode === 'sprite' && p.sprite ? p.sprite.palette : 'db16'
        await p.run('sprite_create', { name, width, height, palette: basePalette })
        spriteRef = name
        if (paletteMode === 'auto') await p.run('palette_set', { name: `${name}-palette`, colors: palette.slice(1), sprite: spriteRef })
      } else {
        if (paletteMode === 'auto' && autoPalette) await p.run('palette_extend', { colors: autoPalette.slice(1), group: name, sprite: spriteRef })
        if (target === 'frame' && p.sprite) {
          await p.run('frame_add', { sprite: spriteRef })
          frame = p.sprite.frames.length // the new last frame
        }
      }
      await p.run('paste_indexed', { sprite: spriteRef, frame, width, height, data: Array.from(result.indexes) })
      if (frame !== undefined) p.onFrame?.(frame)
      p.onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      p.end()
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={p.onClose}>
      <div className="modal" role="dialog" aria-label="Import image" onClick={(e) => e.stopPropagation()}>
        <header>
          <strong>Import image</strong>
          <span className="hint">{fileName(p.image.path)} · {src.width}×{src.height}</span>
        </header>
        <div className="modal-body">
          <div className="preview-box">
            <canvas ref={ref} width={320} height={320} />
            <span className="hint">{width}×{height} · {palette ? palette.length - 1 : 0} colors</span>
          </div>
          <form className="import-form" onSubmit={(e) => { e.preventDefault(); void apply() }}>
            {p.sprite && (
              <label className="wide">Into
                <select value={target} onChange={(e) => setTarget(e.target.value as 'new' | 'frame' | 'current')}>
                  <option value="frame">{p.sprite.name}: new frame at the end</option>
                  <option value="current">{p.sprite.name}: current frame (overwrites)</option>
                  <option value="new">New sprite</option>
                </select>
              </label>
            )}
            {usesNewSprite && <label className="wide">Name <input value={name} onChange={(e) => setName(e.target.value)} required /></label>}
            <label>Width <input type="number" min={1} max={512} value={width} disabled={!usesNewSprite} onChange={(e) => setW(Number(e.target.value))} /></label>
            <label>Height <input type="number" min={1} max={512} value={height} disabled={!usesNewSprite} onChange={(e) => setH(Number(e.target.value))} /></label>
            <label className="check wide"><input type="checkbox" checked={lockAspect} disabled={!usesNewSprite} onChange={(e) => setLockAspect(e.target.checked)} /> Keep aspect ratio</label>
            <label>Fit
              <select value={fit} onChange={(e) => setFit(e.target.value as Fit)}>
                <option value="contain">Contain (pad)</option>
                <option value="cover">Cover (crop)</option>
                <option value="stretch">Stretch</option>
              </select>
            </label>
            <label>Dither
              <select value={dither} onChange={(e) => setDither(e.target.value as Dither)}>
                <option value="none">None (flat)</option>
                <option value="floyd">Floyd–Steinberg</option>
                <option value="ordered">Ordered (retro)</option>
              </select>
            </label>
            <label>Palette
              <select value={paletteMode} onChange={(e) => setPaletteMode(e.target.value as 'sprite' | 'auto')}>
                {spritePalette && !usesNewSprite && <option value="sprite">Sprite palette only ({p.sprite?.palette})</option>}
                {spritePalette && !usesNewSprite && <option value="auto">Sprite palette + colours from the image (new group)</option>}
                {usesNewSprite && <option value="auto">From the image</option>}
                {usesNewSprite && spritePalette && <option value="sprite">Same palette as {p.sprite?.name}</option>}
              </select>
            </label>
            <label>Colors <input type="number" min={2} max={64} value={colorsDraft} disabled={paletteMode !== 'auto'} onChange={(e) => setColorsDraft(Number(e.target.value))} onBlur={() => setColors(Math.max(2, Math.min(64, colorsDraft || 2)))} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setColors(Math.max(2, Math.min(64, colorsDraft || 2))) } }} /></label>
            <label className="wide">Alpha cutoff <span className="hint">{alphaDraft}</span>
              <input
                type="range"
                min={0}
                max={255}
                value={alphaDraft}
                onChange={(e) => setAlphaDraft(Number(e.target.value))}
                onPointerUp={() => setAlpha(alphaDraft)}
                onKeyUp={() => setAlpha(alphaDraft)}
                onBlur={() => setAlpha(alphaDraft)}
              />
            </label>
            <label className="check wide"><input type="checkbox" checked={cleanup} onChange={(e) => setCleanup(e.target.checked)} /> Remove stray pixels</label>
            {error && <div className="wide" style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div>}
            <div className="actions">
              <button type="button" className="mini" onClick={p.onClose}>Cancel</button>
              <button type="submit" className="mini" style={{ background: 'var(--accent)', color: 'var(--accent-text)' }} disabled={!result || busy}>
                {busy ? 'Importing…' : 'Import'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
