import { parseColor } from '../core/palettes'
import { celKey, type Project, type Sprite } from '../core/types'

/**
 * Animated GIF writer for indexed sprites. The sprite palette becomes the global colour table
 * (index 0 = transparent), each frame is the composited, upscaled pixel indexes, LZW-encoded.
 */

function lzwEncode(indexes: Uint8Array, minCodeSize: number): Buffer {
  const clear = 1 << minCodeSize
  const eoi = clear + 1
  const out: number[] = []
  let bitBuf = 0
  let bitCnt = 0
  let nBits = minCodeSize + 1
  let maxcode = (1 << nBits) - 1
  let free = eoi + 1
  let dict = new Map<number, number>()
  const writeRaw = (code: number): void => {
    bitBuf |= code << bitCnt
    bitCnt += nBits
    while (bitCnt >= 8) {
      out.push(bitBuf & 0xff)
      bitBuf >>>= 8
      bitCnt -= 8
    }
  }
  const writeCode = (code: number): void => {
    writeRaw(code)
    if (free > maxcode) {
      nBits++
      maxcode = nBits === 12 ? 4096 : (1 << nBits) - 1
    }
  }
  const reset = (): void => {
    dict = new Map()
    free = eoi + 1
    nBits = minCodeSize + 1
    maxcode = (1 << nBits) - 1
  }
  writeRaw(clear)
  reset()
  if (indexes.length === 0) {
    writeRaw(eoi)
    return Buffer.from(out)
  }
  let ent = indexes[0] as number
  for (let i = 1; i < indexes.length; i++) {
    const c = indexes[i] as number
    const key = (ent << 8) | c
    const hit = dict.get(key)
    if (hit !== undefined) {
      ent = hit
      continue
    }
    writeCode(ent)
    ent = c
    if (free < 4096) dict.set(key, free++)
    else {
      writeRaw(clear)
      reset()
    }
  }
  writeCode(ent)
  writeRaw(eoi)
  if (bitCnt > 0) out.push(bitBuf & 0xff)
  return Buffer.from(out)
}

function subBlocks(data: Buffer): Buffer {
  const parts: Buffer[] = []
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.subarray(i, i + 255)
    parts.push(Buffer.from([chunk.length]), chunk)
  }
  parts.push(Buffer.from([0]))
  return Buffer.concat(parts)
}

/** Composite visible layers of one frame into palette indexes (top layer wins), then upscale. */
function frameIndexes(sprite: Sprite, frame: number, scale: number): Uint8Array {
  const f = sprite.frames[frame]
  if (!f) throw new Error(`Frame ${frame} out of range`)
  const { width: w, height: h } = sprite
  const flat = new Uint8Array(w * h)
  for (const layer of sprite.layers) {
    if (!layer.visible) continue
    const cel = sprite.cels[celKey(layer.id, f.id)]
    if (!cel) continue
    for (let i = 0; i < cel.length; i++) if (cel[i] !== 0) flat[i] = cel[i] as number
  }
  if (scale === 1) return flat
  const out = new Uint8Array(w * h * scale * scale)
  const W = w * scale
  for (let y = 0; y < h * scale; y++) for (let x = 0; x < W; x++) out[y * W + x] = flat[Math.floor(y / scale) * w + Math.floor(x / scale)] as number
  return out
}

export interface GifOptions {
  scale?: number
  /** Frame range (inclusive). Default: all frames, or the tag's range when `tag` is given. */
  from?: number
  to?: number
  tag?: string
  /** 0 = loop forever (default). */
  loops?: number
}

export function encodeGif(project: Project, sprite: Sprite, o: GifOptions = {}): Buffer {
  const pal = project.palettes[sprite.palette]
  if (!pal) throw new Error(`Palette '${sprite.palette}' is missing.`)
  const scale = Math.max(1, Math.floor(o.scale ?? 1))
  let from = o.from ?? 0
  let to = o.to ?? sprite.frames.length - 1
  if (o.tag) {
    const t = sprite.tags.find((x) => x.name === o.tag)
    if (!t) throw new Error(`No tag named '${o.tag}'.`)
    from = t.from
    to = t.to
  }
  if (from < 0 || to >= sprite.frames.length || to < from) throw new Error(`Frame range ${from}..${to} is invalid.`)

  const W = sprite.width * scale
  const H = sprite.height * scale
  // colour table size: power of two ≥ palette length, min 4
  let bits = 2
  while (1 << bits < pal.colors.length) bits++
  const tableSize = 1 << bits
  const table = Buffer.alloc(tableSize * 3)
  pal.colors.forEach((hex, i) => {
    const [r, g, b] = parseColor(hex)
    table[i * 3] = r
    table[i * 3 + 1] = g
    table[i * 3 + 2] = b
  })

  const parts: Buffer[] = []
  parts.push(Buffer.from('GIF89a', 'ascii'))
  const lsd = Buffer.alloc(7)
  lsd.writeUInt16LE(W, 0)
  lsd.writeUInt16LE(H, 2)
  lsd[4] = 0x80 | ((bits - 1) << 4) | (bits - 1) // global table, colour resolution, size
  lsd[5] = 0 // background colour index
  lsd[6] = 0
  parts.push(lsd, table)
  // Netscape looping extension
  const loops = o.loops ?? 0
  parts.push(Buffer.from([0x21, 0xff, 0x0b]), Buffer.from('NETSCAPE2.0', 'ascii'), Buffer.from([3, 1, loops & 0xff, (loops >> 8) & 0xff, 0]))

  for (let i = from; i <= to; i++) {
    const delay = Math.max(2, Math.round((sprite.frames[i] as { duration: number }).duration / 10)) // centiseconds
    const gce = Buffer.alloc(8)
    gce[0] = 0x21
    gce[1] = 0xf9
    gce[2] = 4
    gce[3] = (2 << 2) | 1 // disposal: restore to background; transparent colour flag
    gce.writeUInt16LE(delay, 4)
    gce[6] = 0 // transparent index
    gce[7] = 0
    const desc = Buffer.alloc(10)
    desc[0] = 0x2c
    desc.writeUInt16LE(0, 1)
    desc.writeUInt16LE(0, 3)
    desc.writeUInt16LE(W, 5)
    desc.writeUInt16LE(H, 7)
    desc[9] = 0
    const minCode = Math.max(2, bits)
    parts.push(gce, desc, Buffer.from([minCode]), subBlocks(lzwEncode(frameIndexes(sprite, i, scale), minCode)))
  }
  parts.push(Buffer.from([0x3b]))
  return Buffer.concat(parts)
}
