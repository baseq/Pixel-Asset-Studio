import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Engine, extractPalette, findSprite, pixelate, pixelsAscii, presetPalette, quantize, removeIsolated, resize, type Bitmap } from '../src/core'
import { decodePng } from '../src/main/decode'
import { encodePng } from '../src/main/encode'
import { startMcpServer, type RunningMcp } from '../src/main/mcp'

/** A 64x64 test picture: red left half, blue right half, transparent 16px border, one stray green pixel. */
function picture(): Bitmap {
  const w = 64, h = 64
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const inside = x >= 16 && x < 48 && y >= 16 && y < 48
      if (!inside) continue
      const red = x < 32
      d[o] = red ? 208 : 89
      d[o + 1] = red ? 70 : 125
      d[o + 2] = red ? 72 : 206
      d[o + 3] = 255
    }
  return { width: w, height: h, data: d }
}

describe('pixelate pipeline', () => {
  it('resizes with area averaging and keeps transparency', () => {
    const r = resize(picture(), 8, 8, 'stretch')
    // border cells are fully transparent, inner cells opaque
    expect(r[3]).toBe(0)
    expect(r[(3 * 8 + 3) * 4 + 3]).toBe(255)
    // the cell straddling red/blue at x=3..4? column 3 = source x 24..32 = pure red
    expect(r[(3 * 8 + 3) * 4]).toBeCloseTo(208, 0)
  })

  it('quantizes to the nearest palette colour perceptually', () => {
    const pal = presetPalette('db16').colors // 7 = #d04648 red, 9 = #597dce blue
    const r = pixelate(picture(), pal, { width: 8, height: 8, fit: 'stretch' })
    const at = (x: number, y: number): number => r.indexes[y * 8 + x] as number
    expect(at(0, 0)).toBe(0)
    expect(at(2, 3)).toBe(7)
    expect(at(5, 3)).toBe(9)
  })

  it('contain pads, cover crops', () => {
    const wide: Bitmap = { width: 40, height: 10, data: new Uint8ClampedArray(40 * 10 * 4).fill(255) }
    const pal = presetPalette('db16').colors
    const contain = pixelate(wide, pal, { width: 8, height: 8, fit: 'contain', cleanup: false })
    expect(contain.indexes[0]).toBe(0) // padded row
    expect(contain.indexes[3 * 8]).not.toBe(0)
    const cover = pixelate(wide, pal, { width: 8, height: 8, fit: 'cover', cleanup: false })
    expect(cover.indexes[0]).not.toBe(0)
  })

  it('floyd dithering mixes two palette entries for an in-between colour', () => {
    const grey: Bitmap = { width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4) }
    for (let i = 0; i < 256; i++) grey.data.set([128, 128, 128, 255], i * 4)
    const pal = ['#00000000', '#000000', '#ffffff']
    const flat = quantize(resize(grey, 16, 16, 'stretch'), 16, 16, pal, { dither: 'none' })
    expect(new Set(flat).size).toBe(1)
    const dith = quantize(resize(grey, 16, 16, 'stretch'), 16, 16, pal, { dither: 'floyd' })
    expect(new Set(dith).size).toBe(2)
  })

  it('removes isolated pixels', () => {
    const idx = new Uint8Array([1, 1, 1, 1, 2, 1, 1, 1, 1])
    expect(Array.from(removeIsolated(idx, 3, 3))).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1])
  })

  it('extracts a palette from an image', () => {
    const pal = extractPalette(picture(), 4)
    expect(pal.length).toBeGreaterThanOrEqual(2)
    expect(pal.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true)
  })

  it('decodes what the encoder wrote (RGBA) ', () => {
    const src = picture()
    const back = decodePng(encodePng(src))
    expect(back.width).toBe(64)
    expect(Array.from(back.data)).toEqual(Array.from(src.data))
  })
})

describe('import_image over MCP', () => {
  let mcp: RunningMcp, client: Client, engine: Engine, ws: string
  beforeAll(async () => {
    ws = mkdtempSync(join(tmpdir(), 'pas-import-'))
    writeFileSync(join(ws, 'pic.png'), encodePng(picture()))
    engine = new Engine()
    mcp = await startMcpServer({ engine, workspace: ws, port: 0 })
    client = new Client({ name: 't', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url)))
  })
  afterAll(async () => {
    await client.close()
    await mcp.close()
    rmSync(ws, { recursive: true, force: true })
  })

  it('creates a sprite from a picture and is undoable in one step', async () => {
    const r: any = await client.callTool({ name: 'import_image', arguments: { path: 'pic.png', width: 8, height: 8, fit: 'stretch' } })
    expect(r.isError).toBeFalsy()
    expect(engine.project.sprites[0]?.name).toBe('pic')
    const rows = pixelsAscii(engine.project, {}).rows
    expect(rows[3]?.[2]).toBe('7')
    expect(rows[3]?.[5]).toBe('9')
    await client.callTool({ name: 'undo', arguments: {} })
    expect(engine.project.sprites).toHaveLength(0)
  })

  it('derives a palette with palette=auto', async () => {
    const r: any = await client.callTool({ name: 'import_image', arguments: { path: 'pic.png', width: 8, height: 8, palette: 'auto', colors: 4, name: 'auto' } })
    expect(r.isError).toBeFalsy()
    const s = engine.project.sprites.find((x) => x.name === 'auto')
    expect(s?.palette).toBe('auto-auto')
    expect(engine.project.palettes['auto-auto']?.colors.length).toBeGreaterThanOrEqual(3)
  })

  it('refuses files outside the workspace', async () => {
    const r: any = await client.callTool({ name: 'import_image', arguments: { path: '../x.png' } })
    expect(r.isError).toBe(true)
  })
})

describe('importing into an existing sprite', () => {
  it('palette_extend keeps existing indexes and adds a named group', () => {
    const e = new Engine()
    e.execute('sprite_create', { name: 's', width: 2, height: 1, palette: 'gameboy' })
    e.execute('draw_from_ascii', { rows: ['12'] })
    const before = e.project.palettes['gameboy']?.colors.slice()
    e.execute('palette_extend', { colors: ['#ff0000', '#0f380f', '#00ff00'], group: 'photo' })
    const pal = e.project.palettes['gameboy']!
    expect(pal.colors.slice(0, before!.length)).toEqual(before)
    expect(pal.colors.slice(before!.length)).toEqual(['#ff0000', '#00ff00']) // duplicate skipped
    expect(pal.groups).toEqual([{ name: 'photo', from: 5, to: 6 }])
    expect(pixelsAscii(e.project, {}).rows).toEqual(['12']) // art untouched
  })

  it('import_image with palette=auto on an existing sprite extends and can target a new frame', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'pas-ext-'))
    writeFileSync(join(ws, 'pic.png'), encodePng(picture()))
    const engine = new Engine()
    engine.execute('sprite_create', { name: 'hero', width: 8, height: 8, palette: 'gameboy' })
    engine.execute('draw_rect', { x: 0, y: 0, width: 8, height: 8, color: 2, filled: true })
    const mcp = await startMcpServer({ engine, workspace: ws, port: 0 })
    const client = new Client({ name: 't', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url)))
    const r: any = await client.callTool({ name: 'import_image', arguments: { path: 'pic.png', palette: 'auto', colors: 4, newFrame: true, fit: 'stretch' } })
    expect(r.isError).toBeFalsy()
    const s = findSprite(engine.project)
    expect(s.palette).toBe('gameboy') // not replaced
    expect(engine.project.palettes['gameboy']!.groups?.[0]?.name).toBe('pic')
    expect(s.frames).toHaveLength(2)
    expect(pixelsAscii(engine.project, { frame: 0 }).rows[0]).toBe('22222222') // frame 0 untouched
    expect(pixelsAscii(engine.project, { frame: 1 }).rows[3]).not.toBe('22222222')
    await client.close()
    await mcp.close()
    rmSync(ws, { recursive: true, force: true })
  })
})
