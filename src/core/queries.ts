import { CommandError } from './commands'
import { asciiChar, asciiIndex } from './palettes'
import { celKey, type Project, type Sprite } from './types'

export function findSprite(project: Project, ref?: string): Sprite {
  const key = ref ?? project.activeSprite
  if (key === null || key === undefined) throw new CommandError('There is no active sprite. Call sprite_create first.')
  const s =
    project.sprites.find((x) => x.id === key) ??
    project.sprites.find((x) => x.name.toLowerCase() === String(key).toLowerCase())
  if (!s) {
    const names = project.sprites.map((x) => `'${x.name}'`).join(', ') || 'none yet'
    throw new CommandError(`Sprite '${key}' not found. Existing sprites: ${names}.`)
  }
  return s
}

export function projectInfo(project: Project) {
  return {
    name: project.name,
    activeSprite: project.activeSprite,
    sprites: project.sprites.map(spriteInfo),
    palettes: Object.keys(project.palettes)
  }
}

export function spriteInfo(s: Sprite) {
  return {
    id: s.id,
    name: s.name,
    width: s.width,
    height: s.height,
    palette: s.palette,
    layers: s.layers.map((l, index) => ({ index, name: l.name, visible: l.visible, opacity: l.opacity })),
    frames: s.frames.map((f, index) => ({ index, duration: f.duration })),
    tags: s.tags,
    tileSize: s.tileSize,
    tiles: s.tileSize ? Math.floor(s.width / s.tileSize.w) * Math.floor(s.height / s.tileSize.h) : undefined
  }
}

/** Compare the touching edges of two tiles. side = which edge of tile a touches tile b. */
export function checkSeams(
  project: Project,
  o: { sprite?: string; layer?: string | number; frame?: number; a: number; b: number; side: 'right' | 'bottom' }
): { mismatches: Array<{ offset: number; a: number; b: number }>; length: number } {
  const s = findSprite(project, o.sprite)
  if (!s.tileSize) throw new CommandError(`Sprite '${s.name}' is not a tileset.`)
  const { rows: ra } = pixelsAscii(project, { ...o, ...tileRect(s, o.a) })
  const { rows: rb } = pixelsAscii(project, { ...o, ...tileRect(s, o.b) })
  const mismatches: Array<{ offset: number; a: number; b: number }> = []
  const { w, h } = s.tileSize
  if (o.side === 'right') {
    for (let y = 0; y < h; y++) {
      const ca = asciiIndex(ra[y]?.[w - 1] ?? '.') ?? 0
      const cb = asciiIndex(rb[y]?.[0] ?? '.') ?? 0
      if (ca !== cb) mismatches.push({ offset: y, a: ca, b: cb })
    }
    return { mismatches, length: h }
  }
  for (let x = 0; x < w; x++) {
    const ca = asciiIndex(ra[h - 1]?.[x] ?? '.') ?? 0
    const cb = asciiIndex(rb[0]?.[x] ?? '.') ?? 0
    if (ca !== cb) mismatches.push({ offset: x, a: ca, b: cb })
  }
  return { mismatches, length: w }
}

function tileRect(s: Sprite, i: number): { x: number; y: number; width: number; height: number } {
  const ts = s.tileSize as { w: number; h: number }
  const cols = Math.floor(s.width / ts.w)
  const rows = Math.floor(s.height / ts.h)
  if (i < 0 || i >= cols * rows) throw new CommandError(`Tile ${i} is out of range; tileset has tiles 0..${cols * rows - 1}.`)
  return { x: (i % cols) * ts.w, y: Math.floor(i / cols) * ts.h, width: ts.w, height: ts.h }
}

export function paletteInfo(project: Project, spriteRef?: string) {
  const s = findSprite(project, spriteRef)
  const pal = project.palettes[s.palette]
  if (!pal) throw new CommandError(`Palette '${s.palette}' is missing.`)
  return {
    name: pal.name,
    colors: pal.colors.map((hex, index) => ({ index, hex, ascii: asciiChar(index) }))
  }
}

/** One cel as ASCII art using the default legend, so it can be fed back to draw_from_ascii. */
export function pixelsAscii(
  project: Project,
  o: { sprite?: string; layer?: string | number; frame?: number; x?: number; y?: number; width?: number; height?: number }
): { rows: string[]; x: number; y: number; width: number; height: number } {
  const s = findSprite(project, o.sprite)
  const layer =
    o.layer === undefined
      ? s.layers[0]
      : typeof o.layer === 'number'
        ? s.layers[o.layer]
        : s.layers.find((l) => l.id === o.layer || l.name.toLowerCase() === String(o.layer).toLowerCase())
  if (!layer) throw new CommandError(`Layer '${String(o.layer)}' not found.`)
  const frame = s.frames[o.frame ?? 0]
  if (!frame) throw new CommandError(`Frame ${o.frame} is out of range (0..${s.frames.length - 1}).`)
  const data = s.cels[celKey(layer.id, frame.id)] as Uint8Array
  const x0 = Math.max(0, o.x ?? 0)
  const y0 = Math.max(0, o.y ?? 0)
  const x1 = Math.min(s.width, x0 + (o.width ?? s.width))
  const y1 = Math.min(s.height, y0 + (o.height ?? s.height))
  const rows: string[] = []
  for (let y = y0; y < y1; y++) {
    let row = ''
    for (let x = x0; x < x1; x++) row += asciiChar(data[y * s.width + x] as number)
    rows.push(row)
  }
  return { rows, x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}
