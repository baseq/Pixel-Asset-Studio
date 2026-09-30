import { deflateSync } from 'node:zlib'
import type { Bitmap } from '../core/render'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ (buf[i] as number)) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  out.set(data, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** Encode RGBA pixels as a PNG file. */
export function encodePng(bm: Bitmap): Buffer {
  const { width, height, data } = bm
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0))
  ])
}

/** Encode RGBA pixels as a 32-bit BMP (with alpha, top-down). */
export function encodeBmp(bm: Bitmap): Buffer {
  const { width, height, data } = bm
  const size = width * height * 4
  const out = Buffer.alloc(54 + size)
  out.write('BM', 0, 'ascii')
  out.writeUInt32LE(54 + size, 2)
  out.writeUInt32LE(54, 10)
  out.writeUInt32LE(40, 14)
  out.writeInt32LE(width, 18)
  out.writeInt32LE(-height, 22) // negative = top-down
  out.writeUInt16LE(1, 26)
  out.writeUInt16LE(32, 28)
  out.writeUInt32LE(size, 34)
  for (let i = 0; i < width * height; i++) {
    const o = 54 + i * 4
    out[o] = data[i * 4 + 2] as number
    out[o + 1] = data[i * 4 + 1] as number
    out[o + 2] = data[i * 4] as number
    out[o + 3] = data[i * 4 + 3] as number
  }
  return out
}

export type ImageFormat = 'png' | 'bmp'
export const IMAGE_FORMATS: ImageFormat[] = ['png', 'bmp']

export function encodeImage(bm: Bitmap, format: ImageFormat): Buffer {
  return format === 'bmp' ? encodeBmp(bm) : encodePng(bm)
}
