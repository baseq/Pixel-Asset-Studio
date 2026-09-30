import type { Project, Sprite } from './types'

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

function celToRows(data: Uint8Array, width: number, height: number): string[] {
  const rows: string[] = []
  for (let y = 0; y < height; y++) {
    let row = ''
    for (let x = 0; x < width; x++) row += (data[y * width + x] as number).toString(16).padStart(2, '0')
    rows.push(row)
  }
  return rows
}

function rowsToCel(rows: string[], width: number, height: number): Uint8Array {
  if (rows.length !== height) throw new Error(`Corrupt cel: expected ${height} rows, found ${rows.length}.`)
  const data = new Uint8Array(width * height)
  rows.forEach((row, y) => {
    if (row.length !== width * 2) throw new Error(`Corrupt cel: row ${y} has ${row.length / 2} pixels, expected ${width}.`)
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

export function parseProject(json: string): Project {
  const file = JSON.parse(json) as ProjectFile
  if (file.version !== 1) throw new Error(`Unsupported project version ${String(file.version)}.`)
  return {
    ...file,
    sprites: file.sprites.map((s) => ({
      ...s,
      cels: Object.fromEntries(Object.entries(s.cels).map(([k, rows]) => [k, rowsToCel(rows, s.width, s.height)]))
    }))
  }
}
