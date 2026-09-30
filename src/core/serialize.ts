import { celKey, MAX_SIZE, type Project, type Sprite } from './types'

/**
 * Project files are plain JSON. Each cel is an array of row strings with two hex digits per pixel
 * (the palette index), so files stay readable and diff well in git.
 */
interface SpriteFile extends Omit<Sprite, 'cels'> {
  cels: Record<string, string[]>
}
interface ProjectFile extends Omit<Project, 'sprites'> {
  sprites: SpriteFile[]
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

function celToRows(data: Uint8Array, width: number, height: number): string[] {
  const rows: string[] = []
  const parts = new Array<string>(width)
  for (let y = 0; y < height; y++) {
    const base = y * width
    for (let x = 0; x < width; x++) parts[x] = HEX[data[base + x] as number] as string
    rows.push(parts.join(''))
  }
  return rows
}

function rowsToCel(rows: string[], width: number, height: number): Uint8Array {
  if (rows.length !== height) throw new Error(`Corrupt cel: expected ${height} rows, found ${rows.length}.`)
  const data = new Uint8Array(width * height)
  rows.forEach((row, y) => {
    if (row.length !== width * 2) throw new Error(`Corrupt cel: row ${y} has ${row.length / 2} pixels, expected ${width}.`)
    if (!/^[0-9a-fA-F]*$/.test(row)) throw new Error(`Corrupt cel: row ${y} contains non-hex characters.`)
    for (let x = 0; x < width; x++) data[y * width + x] = parseInt(row.slice(x * 2, x * 2 + 2), 16)
  })
  return data
}

export function serializeProject(project: Project): string {
  const file: ProjectFile = {
    ...project,
    sprites: project.sprites.map((s) => ({
      ...s,
      cels: Object.fromEntries(Object.entries(s.cels).map(([k, v]) => [k, celToRows(v, s.width, s.height)]))
    }))
  }
  return JSON.stringify(file, null, 1)
}

const fail = (msg: string): never => {
  throw new Error(`Invalid project file: ${msg}`)
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Structural checks so a hand-edited or corrupt file fails with a clear message instead of crashing later. */
function validate(file: unknown): asserts file is ProjectFile {
  if (!isObj(file)) return fail('not a JSON object.')
  if (file['version'] !== 1) fail(`unsupported version ${String(file['version'])}.`)
  if (typeof file['name'] !== 'string') fail("missing 'name'.")
  if (!Number.isInteger(file['nextId'])) fail("missing 'nextId'.")
  if (!isObj(file['palettes'])) fail("missing 'palettes'.")
  if (!Array.isArray(file['sprites'])) fail("missing 'sprites'.")
  const palettes = file['palettes'] as Record<string, unknown>
  for (const [k, p] of Object.entries(palettes))
    if (!isObj(p) || !Array.isArray(p['colors']) || p['colors'].length < 1 || !p['colors'].every((c) => typeof c === 'string'))
      fail(`palette '${k}' is malformed.`)
  const ids = new Set<string>()
  for (const s of file['sprites'] as unknown[]) {
    if (!isObj(s)) return fail('a sprite is malformed.')
    const id = s['id']
    if (typeof id !== 'string' || ids.has(id)) fail(`sprite id '${String(id)}' is missing or duplicated.`)
    ids.add(id as string)
    const w = s['width']
    const h = s['height']
    if (!Number.isInteger(w) || !Number.isInteger(h) || (w as number) < 1 || (h as number) < 1 || (w as number) > MAX_SIZE || (h as number) > MAX_SIZE)
      fail(`sprite '${id as string}' has invalid dimensions.`)
    if (typeof s['palette'] !== 'string' || !palettes[s['palette']]) fail(`sprite '${id as string}' uses an unknown palette.`)
    if (!Array.isArray(s['layers']) || !Array.isArray(s['frames']) || !Array.isArray(s['tags']) || !isObj(s['cels']))
      fail(`sprite '${id as string}' is missing layers, frames, tags or cels.`)
    const layers = s['layers'] as Array<{ id?: unknown }>
    const frames = s['frames'] as Array<{ id?: unknown }>
    const cels = s['cels'] as Record<string, unknown>
    for (const l of layers) if (!isObj(l) || typeof l.id !== 'string') fail(`sprite '${id as string}' has a malformed layer.`)
    for (const f of frames) if (!isObj(f) || typeof f.id !== 'string') fail(`sprite '${id as string}' has a malformed frame.`)
    if (!layers.length || !frames.length) fail(`sprite '${id as string}' needs at least one layer and one frame.`)
    for (const l of layers)
      for (const f of frames)
        if (!Array.isArray(cels[celKey(l.id as string, f.id as string)]))
          fail(`sprite '${id as string}' is missing pixel data for layer '${l.id as string}' frame '${f.id as string}'.`)
  }
  const active = file['activeSprite']
  if (active !== null && !ids.has(active as string)) fail('activeSprite does not match any sprite.')
}

export function parseProject(json: string): Project {
  const file: unknown = JSON.parse(json)
  validate(file)
  const maxColors = (name: string): number => (file.palettes[name] as { colors: string[] }).colors.length
  return {
    ...file,
    sprites: file.sprites.map((s) => {
      const cels = Object.fromEntries(Object.entries(s.cels).map(([k, rows]) => [k, rowsToCel(rows, s.width, s.height)]))
      const limit = maxColors(s.palette)
      for (const [k, d] of Object.entries(cels))
        for (let i = 0; i < d.length; i++)
          if ((d[i] as number) >= limit) throw new Error(`Invalid project file: cel '${k}' uses color index ${d[i]} but palette '${s.palette}' has ${limit} colors.`)
      return { ...s, cels }
    })
  }
}
