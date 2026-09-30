import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Engine, pixelsAscii } from '../src/core'
import { startMcpServer, type RunningMcp } from '../src/main/mcp'

let mcp: RunningMcp
let client: Client
let engine: Engine
let workspace: string

const textOf = (r: any): string => r.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'pas-'))
  engine = new Engine()
  mcp = await startMcpServer({ engine, workspace, port: 0 })
  client = new Client({ name: 'test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url)))
})

afterAll(async () => {
  await client.close()
  await mcp.close()
  rmSync(workspace, { recursive: true, force: true })
})

describe('MCP server', () => {
  it('lists tools generated from the commands plus inspection and export tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name)
    for (const n of ['sprite_create', 'draw_from_ascii', 'draw_rect', 'render_snapshot', 'export_spritesheet', 'undo', 'group_begin']) {
      expect(names).toContain(n)
    }
  })

  it('lets an agent create, draw, look and export', async () => {
    let r: any = await client.callTool({ name: 'sprite_create', arguments: { name: 'slime', width: 8, height: 8, palette: 'db16' } })
    expect(r.isError).toBeFalsy()

    await client.callTool({ name: 'group_begin', arguments: { label: 'body' } })
    r = await client.callTool({
      name: 'draw_from_ascii',
      arguments: { rows: ['..2222..', '.233332.', '23333332', '23533532', '23333332', '23333332', '.233332.', '..2222..'] }
    })
    expect(textOf(r)).toMatch(/64 pixels|pixels changed/)
    await client.callTool({ name: 'group_end', arguments: {} })
    expect(pixelsAscii(engine.project, {}).rows[3]).toBe('23533532')
    expect(engine.log.at(-1)?.actor).toBe('agent')

    r = await client.callTool({ name: 'render_snapshot', arguments: {} })
    const img = r.content.find((c: any) => c.type === 'image')
    expect(img.mimeType).toBe('image/png')
    expect(Buffer.from(img.data, 'base64').subarray(1, 4).toString('ascii')).toBe('PNG')

    r = await client.callTool({ name: 'frame_add', arguments: { copyFrom: 0 } })
    r = await client.callTool({ name: 'export_spritesheet', arguments: { path: 'slime-sheet.png', scale: 2 } })
    expect(r.isError).toBeFalsy()
    expect(existsSync(join(workspace, 'slime-sheet.png'))).toBe(true)
    const atlas = JSON.parse(readFileSync(join(workspace, 'slime-sheet.json'), 'utf8'))
    expect(atlas.frames).toHaveLength(2)
    expect(atlas.frames[1]).toMatchObject({ x: 16, y: 0, w: 16, h: 16 })

    r = await client.callTool({ name: 'project_save', arguments: { path: 'slime.pxs' } })
    expect(r.isError).toBeFalsy()
  })

  it('groups an agent edit so a single undo removes it', async () => {
    await client.callTool({ name: 'group_begin', arguments: {} })
    await client.callTool({ name: 'draw_pixels', arguments: { pixels: [{ x: 0, y: 0, color: 9 }] } })
    await client.callTool({ name: 'draw_pixels', arguments: { pixels: [{ x: 1, y: 0, color: 9 }] } })
    await client.callTool({ name: 'group_end', arguments: {} })
    expect(pixelsAscii(engine.project, {}).rows[0]?.slice(0, 2)).toBe('99')
    await client.callTool({ name: 'undo', arguments: {} })
    expect(pixelsAscii(engine.project, {}).rows[0]?.slice(0, 2)).toBe('..')
  })

  it('returns readable errors instead of crashing', async () => {
    const r: any = await client.callTool({ name: 'draw_pixels', arguments: { pixels: [{ x: 0, y: 0, color: 200 }] } })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/out of range/)
  })

  it('refuses paths outside the workspace', async () => {
    for (const path of ['../evil.png', '/tmp/evil.png']) {
      const r: any = await client.callTool({ name: 'export_image', arguments: { path } })
      expect(r.isError).toBe(true)
      expect(textOf(r)).toMatch(/outside the workspace/)
    }
  })

  it('rejects requests with a foreign Host header', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: mcp.port, path: '/mcp', method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' } },
        (res) => resolve(res.statusCode ?? 0)
      )
      req.on('error', reject)
      req.end('{}')
    })
    expect(status).toBe(403)
  })
})
