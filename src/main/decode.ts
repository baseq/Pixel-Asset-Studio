import { inflateSync } from 'node:zlib'
import type { Bitmap } from '../core/render'

/**
 * Minimal PNG decoder: 8-bit greyscale, grey+alpha, RGB, RGBA and indexed, non-interlaced.
 * Enough for the pixel-art and screenshot files people import; anything else is handed to
 * Electron's nativeImage by the caller.
 */
export function decodePng(buf: Buffer): Bitmap {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (buf.length < 8 || sig.some((b, i) => buf[i] !== b)) throw new Error('Not a PNG file.')
  let pos = 8
  let width = 0, height = 0, depth = 0, ctype = 0, interlace = 0
  const idat: Buffer[] = []
  let plte: Buffer | null = null
  let trns: Buffer | null = null
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8] as number
      ctype = data[9] as number
      interlace = data[12] as number
    } else if (type === 'PLTE') plte = data
    else if (type === 'tRNS') trns = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (depth !== 8) throw new Error(`Unsupported PNG bit depth ${depth}; only 8-bit PNGs are supported.`)
  if (interlace) throw new Error('Interlaced PNGs are not supported.')
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype]
  if (!channels) throw new Error(`Unsupported PNG color type ${ctype}.`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = new Uint8ClampedArray(width * height * 4)
  const prev = new Uint8Array(stride)
  const cur = new Uint8Array(stride)
  let rp = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++] as number
    for (let i = 0; i < stride; i++) {
      const x = raw[rp++] as number
      const a = i >= channels ? (cur[i - channels] as number) : 0
      const b = prev[i] as number
      const c = i >= channels ? (prev[i - channels] as number) : 0
      let v: number
      switch (filter) {
        case 0: v = x; break
        case 1: v = x + a; break
        case 2: v = x + b; break
        case 3: v = x + ((a + b) >> 1); break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default: throw new Error(`Bad PNG filter ${filter}.`)
      }
      cur[i] = v & 0xff
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      const s = x * channels
      if (ctype === 6) out.set(cur.subarray(s, s + 4), o)
      else if (ctype === 2) { out[o] = cur[s] as number; out[o + 1] = cur[s + 1] as number; out[o + 2] = cur[s + 2] as number; out[o + 3] = 255 }
      else if (ctype === 0) { const g = cur[s] as number; out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = 255 }
      else if (ctype === 4) { const g = cur[s] as number; out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = cur[s + 1] as number }
      else if (ctype === 3) {
        const idx = cur[s] as number
        out[o] = plte?.[idx * 3] ?? 0
        out[o + 1] = plte?.[idx * 3 + 1] ?? 0
        out[o + 2] = plte?.[idx * 3 + 2] ?? 0
        out[o + 3] = trns && idx < trns.length ? (trns[idx] as number) : 255
      }
    }
    prev.set(cur)
  }
  return { width, height, data: out }
}

export type ImageDecoder = (path: string) => Bitmap
