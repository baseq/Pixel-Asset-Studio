import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Engine, checkSeams, findSprite, parseProject, pixelsAscii, renderTilemap, serializeProject } from '../src/core'
import { startMcpServer, type RunningMcp } from '../src/main/mcp'

describe('tilesets', () => {
  it('creates a tileset and draws into numbered tiles', () => {
    const e = new Engine()
    e.execute('tileset_create', { name: 'terrain', tileWidth: 2, tileHeight: 2, columns: 3, rows: 2, palette: 'db16' })
    const s = findSprite(e.project)
    expect([s.width, s.height]).toEqual([6, 4])
    expect(s.tileSize).toEqual({ w: 2, h: 2 })
    e.execute('tile_draw_from_ascii', { tile: 4, rows: ['12', '34'] })
    expect(pixelsAscii(e.project, {}).rows).toEqual(['......', '......', '..12..', '..34..'])
    e.execute('tile_copy', { from: 4, to: 0 })
    expect(pixelsAscii(e.project, {}).rows[0]).toBe('12....')
    expect(() => e.execute('tile_draw_from_ascii', { tile: 6, rows: ['1'] })).toThrow(/out of range/)
    const back = parseProject(serializeProject(e.project))
    expect(back.sprites[0]?.tileSize).toEqual({ w: 2, h: 2 })
  })

  it('checks seams and renders a tilemap', () => {
    const e = new Engine()
    e.execute('tileset_create', { name: 't', tileWidth: 2, tileHeight: 2, columns: 2, rows: 1, palette: 'db16' })
    e.execute('tile_draw_from_ascii', { tile: 0, rows: ['11', '12'] })
    e.execute('tile_draw_from_ascii', { tile: 1, rows: ['13', '23'] })
    const r = checkSeams(e.project, { a: 0, b: 1, side: 'right' })
    expect(r.length).toBe(2)
    // row0: a right = '1', b left = '1' ok; row1: a right='2', b left='2' ok
    expect(r.mismatches).toHaveLength(0)
    const bad = checkSeams(e.project, { a: 1, b: 0, side: 'right' })
    expect(bad.mismatches.length).toBeGreaterThan(0)
    const bm = renderTilemap(e.project, findSprite(e.project), [[0, 1], [1, -1].map((t) => (t < 0 ? null : t))])
    expect([bm.width, bm.height]).toEqual([4, 4])
    expect(bm.data[3]).toBe(255) // (0,0) opaque from tile 0
    expect(bm.data[(3 * 4 + 3) * 4 + 3]).toBe(0) // empty cell stays transparent
  })
})

describe('tileset tools over MCP', () => {
  let mcp: RunningMcp, client: Client, ws: string
  beforeAll(async () => {
    ws = mkdtempSync(join(tmpdir(), 'pas-tiles-'))
    mcp = await startMcpServer({ engine: new Engine(), workspace: ws, port: 0 })
    client = new Client({ name: 't', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url)))
  })
  afterAll(async () => {
    await client.close()
    await mcp.close()
    rmSync(ws, { recursive: true, force: true })
  })
  it('exposes tileset_create, check_seams and tilemap_preview', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name)
    for (const n of ['tileset_create', 'tile_draw_from_ascii', 'tile_copy', 'check_seams', 'tilemap_preview']) expect(names).toContain(n)
    await client.callTool({ name: 'tileset_create', arguments: { name: 'g', tileWidth: 4, tileHeight: 4, columns: 2, rows: 2 } })
    await client.callTool({ name: 'tile_draw_from_ascii', arguments: { tile: 0, rows: ['6666', '6666', '6666', '6666'] } })
    const seam: any = await client.callTool({ name: 'check_seams', arguments: { a: 0, b: 1, side: 'right' } })
    expect(seam.content[0].text).toMatch(/differ/)
    const prev: any = await client.callTool({ name: 'tilemap_preview', arguments: { map: [[0, 0], [0, 1]] } })
    expect(prev.content.some((c: any) => c.type === 'image')).toBe(true)
  })
})
