import { parseColor, type RGBA } from './palettes'
import type { Bitmap } from './render'

/**
 * Turning a photo or drawing into indexed pixel art:
 *   1. resize with a box filter (area average), cropping or padding to the target size
 *   2. quantize every pixel to the nearest palette entry, measured in Oklab (perceptual)
 *   3. optional dithering (Floyd–Steinberg or ordered/Bayer)
 *   4. cleanup: hard alpha edge and removal of isolated stray pixels
 * A palette can also be derived from the image with median cut.
 */

export type Fit = 'contain' | 'cover' | 'stretch'
export type Dither = 'none' | 'floyd' | 'ordered'

export interface PixelateOptions {
  width: number
  height: number
  fit?: Fit
  dither?: Dither
  /** 0..255; pixels with alpha below this become transparent. Default 128. */
  alphaThreshold?: number
  /** Replace single pixels that differ from all 4 neighbours. Default true. */
  cleanup?: boolean
}

export interface PixelateResult {
  width: number
  height: number
  /** Palette indexes, row-major. 0 = transparent. */
  indexes: Uint8Array
}

// ---- resize -----------------------------------------------------------------

/** Area-average resize of a region of `src` into a w×h buffer. */
function boxResize(src: Bitmap, sx: number, sy: number, sw: number, sh: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    const y0 = sy + (y * sh) / h
    const y1 = sy + ((y + 1) * sh) / h
    for (let x = 0; x < w; x++) {
      const x0 = sx + (x * sw) / w
      const x1 = sx + ((x + 1) * sw) / w
      let r = 0, g = 0, b = 0, a = 0, wsum = 0
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const fy = Math.min(y1, yy + 1) - Math.max(y0, yy)
        if (fy <= 0 || yy < 0 || yy >= src.height) continue
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const fx = Math.min(x1, xx + 1) - Math.max(x0, xx)
          if (fx <= 0 || xx < 0 || xx >= src.width) continue
          const wgt = fx * fy
          const i = (yy * src.width + xx) * 4
          const pa = (src.data[i + 3] as number) / 255
          // premultiply so transparent pixels don't bleed their colour in
          r += (src.data[i] as number) * pa * wgt
          g += (src.data[i + 1] as number) * pa * wgt
          b += (src.data[i + 2] as number) * pa * wgt
          a += pa * wgt
          wsum += wgt
        }
      }
      const o = (y * w + x) * 4
      if (a > 0) {
        out[o] = r / a
        out[o + 1] = g / a
        out[o + 2] = b / a
      }
      out[o + 3] = wsum > 0 ? (a / wsum) * 255 : 0
    }
  }
  return out
}

/** Resize to w×h honouring `fit`. Contain pads with transparency; cover crops the centre. */
export function resize(src: Bitmap, w: number, h: number, fit: Fit = 'contain'): Float32Array {
  if (fit === 'stretch') return boxResize(src, 0, 0, src.width, src.height, w, h)
  const scale = fit === 'contain' ? Math.min(w / src.width, h / src.height) : Math.max(w / src.width, h / src.height)
  const dw = Math.max(1, Math.round(src.width * scale))
  const dh = Math.max(1, Math.round(src.height * scale))
  if (fit === 'cover') {
    // crop the centre of the source so that it maps exactly onto w×h
    const sw = w / scale
    const sh = h / scale
    return boxResize(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, w, h)
  }
  const inner = boxResize(src, 0, 0, src.width, src.height, dw, dh)
  const out = new Float32Array(w * h * 4)
  const ox = Math.floor((w - dw) / 2)
  const oy = Math.floor((h - dh) / 2)
  for (let y = 0; y < dh; y++) {
    out.set(inner.subarray(y * dw * 4, (y + 1) * dw * 4), ((oy + y) * w + ox) * 4)
  }
  return out
}

// ---- colour space -----------------------------------------------------------

export type Lab = [number, number, number]

const lin = (c: number): number => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

/** sRGB (0..255) → Oklab. */
export function toOklab(r: number, g: number, b: number): Lab {
  const lr = lin(r), lg = lin(g), lb = lin(b)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}

const dist2 = (a: Lab, b: Lab): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2

// ---- quantize ---------------------------------------------------------------

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

/**
 * Map an RGBA float buffer onto palette indexes. `palette` is the sprite palette including
 * the transparent slot at 0; only indexes ≥ 1 are candidates for opaque pixels.
 */
export function quantize(rgba: Float32Array, w: number, h: number, palette: string[], o: { dither?: Dither; alphaThreshold?: number } = {}): Uint8Array {
  const dither = o.dither ?? 'none'
  const thr = o.alphaThreshold ?? 128
  const labs: Array<{ idx: number; lab: Lab; rgb: RGBA }> = []
  palette.forEach((hex, idx) => {
    if (idx === 0) return
    const c = parseColor(hex)
    if (c[3] === 0) return
    labs.push({ idx, lab: toOklab(c[0], c[1], c[2]), rgb: c })
  })
  if (!labs.length) throw new Error('The palette has no opaque colors to quantize to.')
  const nearest = (r: number, g: number, b: number): { idx: number; rgb: RGBA } => {
    const lab = toOklab(r, g, b)
    let best = labs[0] as (typeof labs)[number]
    let bd = Infinity
    for (const p of labs) {
      const d = dist2(lab, p.lab)
      if (d < bd) {
        bd = d
        best = p
      }
    }
    return best
  }

  const out = new Uint8Array(w * h)
  const buf = Float32Array.from(rgba) // error diffusion mutates
  const clamp = (v: number): number => Math.max(0, Math.min(255, v))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      if ((buf[i + 3] as number) < thr) {
        out[y * w + x] = 0
        continue
      }
      let r = buf[i] as number, g = buf[i + 1] as number, b = buf[i + 2] as number
      if (dither === 'ordered') {
        const t = ((BAYER4[(y % 4) * 4 + (x % 4)] as number) / 16 - 0.5) * 40
        r = clamp(r + t)
        g = clamp(g + t)
        b = clamp(b + t)
      }
      const p = nearest(r, g, b)
      out[y * w + x] = p.idx
      if (dither === 'floyd') {
        const er = r - p.rgb[0], eg = g - p.rgb[1], eb = b - p.rgb[2]
        const push = (dx: number, dy: number, f: number): void => {
          const xx = x + dx, yy = y + dy
          if (xx < 0 || xx >= w || yy >= h) return
          const j = (yy * w + xx) * 4
          if ((buf[j + 3] as number) < thr) return
          buf[j] = clamp((buf[j] as number) + er * f)
          buf[j + 1] = clamp((buf[j + 1] as number) + eg * f)
          buf[j + 2] = clamp((buf[j + 2] as number) + eb * f)
        }
        push(1, 0, 7 / 16)
        push(-1, 1, 3 / 16)
        push(0, 1, 5 / 16)
        push(1, 1, 1 / 16)
      }
    }
  }
  return out
}

/** Replace pixels whose 4 neighbours all differ from them with the most common neighbour. */
export function removeIsolated(idx: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(idx)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = idx[y * w + x] as number
      const n: number[] = []
      if (x > 0) n.push(idx[y * w + x - 1] as number)
      if (x < w - 1) n.push(idx[y * w + x + 1] as number)
      if (y > 0) n.push(idx[(y - 1) * w + x] as number)
      if (y < h - 1) n.push(idx[(y + 1) * w + x] as number)
      if (n.length < 3 || n.includes(v)) continue
      const counts = new Map<number, number>()
      for (const c of n) counts.set(c, (counts.get(c) ?? 0) + 1)
      let best = v, bc = 0
      for (const [c, k] of counts) if (k > bc) (best = c), (bc = k)
      if (bc >= 2) out[y * w + x] = best
    }
  }
  return out
}

/** The full pipeline: source bitmap + sprite palette → indexes. */
export function pixelate(src: Bitmap, palette: string[], o: PixelateOptions): PixelateResult {
  const rgba = resize(src, o.width, o.height, o.fit ?? 'contain')
  let indexes = quantize(rgba, o.width, o.height, palette, { dither: o.dither, alphaThreshold: o.alphaThreshold })
  if (o.cleanup ?? true) indexes = removeIsolated(indexes, o.width, o.height)
  return { width: o.width, height: o.height, indexes }
}

// ---- palette extraction (median cut) -----------------------------------------

const hex2 = (n: number): string => Math.round(n).toString(16).padStart(2, '0')

/** Pick up to `count` representative colours from an image (opaque pixels only) using median cut. */
export function extractPalette(src: Bitmap | { data: Float32Array | Uint8ClampedArray; width: number; height: number }, count: number, alphaThreshold = 128): string[] {
  const pts: Array<[number, number, number]> = []
  const d = src.data
  for (let i = 0; i < src.width * src.height; i++) {
    if ((d[i * 4 + 3] as number) < alphaThreshold) continue
    pts.push([d[i * 4] as number, d[i * 4 + 1] as number, d[i * 4 + 2] as number])
  }
  if (!pts.length) return []
  // Sample for speed on big images.
  const step = Math.max(1, Math.floor(pts.length / 20000))
  let boxes: Array<Array<[number, number, number]>> = [pts.filter((_, i) => i % step === 0)]
  while (boxes.length < count) {
    boxes.sort((a, b) => b.length - a.length)
    const box = boxes.shift() as Array<[number, number, number]>
    if (box.length < 2) {
      boxes.push(box)
      break
    }
    const range = [0, 1, 2].map((c) => Math.max(...box.map((p) => p[c] as number)) - Math.min(...box.map((p) => p[c] as number)))
    const axis = range.indexOf(Math.max(...range))
    box.sort((a, b) => (a[axis] as number) - (b[axis] as number))
    const mid = Math.floor(box.length / 2)
    boxes.push(box.slice(0, mid), box.slice(mid))
  }
  const colors = boxes.map((box) => {
    const n = box.length
    const s = box.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]], [0, 0, 0])
    return `#${hex2(s[0] / n)}${hex2(s[1] / n)}${hex2(s[2] / n)}`
  })
  // de-duplicate, darkest first so index 1 is a good outline colour
  return [...new Set(colors)].sort((a, b) => toOklab(...parseColor(a).slice(0, 3) as [number, number, number])[0] - toOklab(...parseColor(b).slice(0, 3) as [number, number, number])[0])
}
