import type { Palette } from './types'

const split = (s: string): string[] => s.split(' ')

/** Built-in palettes. Drawable colors here become indexes 1..N (index 0 is transparent). */
export const PRESETS: Record<string, string[]> = {
  pico8: split(
    '#000000 #1d2b53 #7e2553 #008751 #ab5236 #5f574f #c2c3c7 #fff1e8 #ff004d #ffa300 #ffec27 #00e436 #29adff #83769c #ff77a8 #ffccaa'
  ),
  db16: split(
    '#140c1c #442434 #30346d #4e4a4e #854c30 #346524 #d04648 #757161 #597dce #d27d2c #8595a1 #6daa2c #d2aa99 #6dc2ca #dad45e #deeed6'
  ),
  gameboy: split('#0f380f #306230 #8bac0f #9bbc0f')
}

export const PRESET_NAMES = Object.keys(PRESETS) as [string, ...string[]]

export function presetPalette(preset: string, name = preset): Palette {
  const colors = PRESETS[preset]
  if (!colors) throw new Error(`Unknown palette preset '${preset}'. Available: ${PRESET_NAMES.join(', ')}`)
  return { name, colors: ['#00000000', ...colors] }
}

export type RGBA = [number, number, number, number]

/** Parse "#rrggbb" or "#rrggbbaa". */
export function parseColor(hex: string): RGBA {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim())
  if (!m) throw new Error(`Invalid color '${hex}'. Use #rrggbb or #rrggbbaa.`)
  const rgb = m[1] as string
  const a = m[2] ? parseInt(m[2], 16) : 255
  return [parseInt(rgb.slice(0, 2), 16), parseInt(rgb.slice(2, 4), 16), parseInt(rgb.slice(4, 6), 16), a]
}

/** Character used to show a palette index in ASCII art. 0 = '.', 1-35 = 1-9 a-z, 36-61 = A-Z... */
const ASCII_CHARS = '.123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

export function asciiChar(index: number): string {
  return ASCII_CHARS[index] ?? '?'
}

export function asciiIndex(ch: string): number | undefined {
  const i = ASCII_CHARS.indexOf(ch)
  return i === -1 ? undefined : i
}
