import { parseColor, type RGBA } from './palettes'
import { celKey, type Project, type Sprite } from './types'

export interface Bitmap {
  width: number
  height: number
  /** RGBA, 4 bytes per pixel. */
  data: Uint8ClampedArray
}

function paletteRgba(project: Project, sprite: Sprite): RGBA[] {
  const pal = project.palettes[sprite.palette]
  if (!pal) throw new Error(`Palette '${sprite.palette}' is missing.`)
  return pal.colors.map(parseColor)
}

/** Composite all visible layers of one frame. Transparent pixels stay transparent. */
export function renderFrame(project: Project, sprite: Sprite, frameIndex: number): Bitmap {
  const frame = sprite.frames[frameIndex]
  if (!frame) throw new Error(`Frame ${frameIndex} is out of range (0..${sprite.frames.length - 1}).`)
  const colors = paletteRgba(project, sprite)
  const { width, height } = sprite
  const out = new Uint8ClampedArray(width * height * 4)
  for (const layer of sprite.layers) {
    if (!layer.visible || layer.opacity <= 0) continue
    const cel = sprite.cels[celKey(layer.id, frame.id)]
    if (!cel) continue
    for (let i = 0; i < cel.length; i++) {
      const idx = cel[i] as number
      if (idx === 0) continue
      const c = colors[idx]
      if (!c) continue
      const sa = (c[3] / 255) * layer.opacity
      if (sa <= 0) continue
      const o = i * 4
      const da = (out[o + 3] as number) / 255
      const oa = sa + da * (1 - sa)
      for (let k = 0; k < 3; k++) {
        out[o + k] = ((c[k] as number) * sa + (out[o + k] as number) * da * (1 - sa)) / oa
      }
      out[o + 3] = oa * 255
    }
  }
  return { width, height, data: out }
}

export type Background = 'checker' | 'transparent' | string

export interface UpscaleOptions {
  scale: number
  /** Draw pixel grid lines (needs scale >= 6). Every 8th line is stronger. */
  grid?: boolean
  /** 'checker' (default), 'transparent', or a #rrggbb color. */
  background?: Background
}

const CHECK_A: RGBA = [204, 204, 212, 255]
const CHECK_B: RGBA = [178, 178, 190, 255]

/** Nearest-neighbour upscale, optionally over a background and with a pixel grid. */
export function upscale(src: Bitmap, opts: UpscaleOptions): Bitmap {
  const s = Math.max(1, Math.floor(opts.scale))
  const bg = opts.background ?? 'checker'
  const solid = bg !== 'checker' && bg !== 'transparent' ? parseColor(bg) : null
  const W = src.width * s
  const H = src.height * s
  const out = new Uint8ClampedArray(W * H * 4)
  const grid = opts.grid && s >= 6
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const si = (y * src.width + x) * 4
      const sa = (src.data[si + 3] as number) / 255
      let base: RGBA | null = null
      if (bg === 'checker') base = (x + y) % 2 === 0 ? CHECK_A : CHECK_B
      else if (solid) base = solid
      for (let j = 0; j < s; j++) {
        for (let i = 0; i < s; i++) {
          const o = ((y * s + j) * W + (x * s + i)) * 4
          let r: number, g: number, b: number, a: number
          if (base) {
            r = (src.data[si] as number) * sa + base[0] * (1 - sa)
            g = (src.data[si + 1] as number) * sa + base[1] * (1 - sa)
            b = (src.data[si + 2] as number) * sa + base[2] * (1 - sa)
            a = 255
          } else {
            r = src.data[si] as number
            g = src.data[si + 1] as number
            b = src.data[si + 2] as number
            a = src.data[si + 3] as number
          }
          if (grid && (i === 0 || j === 0)) {
            const strong = (i === 0 && x % 8 === 0) || (j === 0 && y % 8 === 0)
            const t = strong ? 0.55 : 0.22
            r *= 1 - t
            g *= 1 - t
            b *= 1 - t
            a = Math.max(a, 255 * t)
          }
          out[o] = r
          out[o + 1] = g
          out[o + 2] = b
          out[o + 3] = a
        }
      }
    }
  }
  return { width: W, height: H, data: out }
}

/** Place frames side by side (or in a grid when columns is set). No background, no gaps. */
export function spriteSheet(project: Project, sprite: Sprite, scale = 1, columns?: number): Bitmap {
  const n = sprite.frames.length
  const cols = Math.min(Math.max(1, columns ?? n), n)
  const rows = Math.ceil(n / cols)
  const fw = sprite.width * scale
  const fh = sprite.height * scale
  const out = new Uint8ClampedArray(cols * fw * rows * fh * 4)
  const W = cols * fw
  for (let f = 0; f < n; f++) {
    const bm = upscale(renderFrame(project, sprite, f), { scale, background: 'transparent' })
    const ox = (f % cols) * fw
    const oy = Math.floor(f / cols) * fh
    for (let y = 0; y < fh; y++) {
      out.set(bm.data.subarray(y * fw * 4, (y + 1) * fw * 4), ((oy + y) * W + ox) * 4)
    }
  }
  return { width: W, height: rows * fh, data: out }
}

/** All frames in one row with a small gap, over a background: for agents to review an animation. */
export function animationStrip(project: Project, sprite: Sprite, opts: UpscaleOptions): Bitmap {
  const gap = 4
  const frames = sprite.frames.map((_, i) => upscale(renderFrame(project, sprite, i), opts))
  const first = frames[0] as Bitmap
  const W = frames.length * first.width + (frames.length - 1) * gap
  const out = new Uint8ClampedArray(W * first.height * 4)
  frames.forEach((bm, f) => {
    const ox = f * (first.width + gap)
    for (let y = 0; y < bm.height; y++) {
      out.set(bm.data.subarray(y * bm.width * 4, (y + 1) * bm.width * 4), (y * W + ox) * 4)
    }
  })
  return { width: W, height: first.height, data: out }
}

/** Crop a region of a bitmap. Out-of-range areas are clamped. */
export function crop(src: Bitmap, x: number, y: number, w: number, h: number): Bitmap {
  const x0 = Math.max(0, x)
  const y0 = Math.max(0, y)
  const x1 = Math.min(src.width, x + w)
  const y1 = Math.min(src.height, y + h)
  const cw = Math.max(0, x1 - x0)
  const ch = Math.max(0, y1 - y0)
  const out = new Uint8ClampedArray(cw * ch * 4)
  for (let j = 0; j < ch; j++) {
    out.set(src.data.subarray(((y0 + j) * src.width + x0) * 4, ((y0 + j) * src.width + x0 + cw) * 4), j * cw * 4)
  }
  return { width: cw, height: ch, data: out }
}

/** Lay tiles of a tileset out according to a 2-D map of tile numbers (-1 or null = empty). */
export function renderTilemap(project: Project, sprite: Sprite, map: Array<Array<number | null>>): Bitmap {
  const ts = sprite.tileSize
  if (!ts) throw new Error(`Sprite '${sprite.name}' is not a tileset.`)
  const cols = Math.floor(sprite.width / ts.w)
  const rows = Math.floor(sprite.height / ts.h)
  const src = renderFrame(project, sprite, 0)
  const mapW = Math.max(...map.map((r) => r.length))
  const W = mapW * ts.w
  const H = map.length * ts.h
  const out = new Uint8ClampedArray(W * H * 4)
  map.forEach((row, my) => {
    row.forEach((t, mx) => {
      if (t === null || t < 0) return
      if (t >= cols * rows) throw new Error(`Tile ${t} is out of range; tileset has tiles 0..${cols * rows - 1}.`)
      const sx = (t % cols) * ts.w
      const sy = Math.floor(t / cols) * ts.h
      for (let y = 0; y < ts.h; y++) {
        const from = ((sy + y) * sprite.width + sx) * 4
        out.set(src.data.subarray(from, from + ts.w * 4), ((my * ts.h + y) * W + mx * ts.w) * 4)
      }
    })
  })
  return { width: W, height: H, data: out }
}
