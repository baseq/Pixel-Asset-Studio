import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { basename, extname } from 'node:path'
import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  animationStrip,
  COMMANDS,
  crop,
  CommandError,
  findSprite,
  paletteInfo,
  pixelsAscii,
  projectInfo,
  renderFrame,
  renderTilemap,
  checkSeams,
  spriteInfo,
  upscale,
  type Engine
} from '../core'
import { IMAGE_FORMATS, encodePng, type ImageFormat } from './encode'
import { exportImageFile, exportSheetFiles } from './exporter'
import { encodeGif } from './gif'
import { writeFileEnsuringDir } from './files'
import { openProject, PROJECT_EXT, resolveInWorkspace, saveProject } from './files'
import { decodePng, type ImageDecoder } from './decode'
import { extractPalette, pixelate } from '../core/pixelate'

export interface McpOptions {
  engine: Engine
  /** Folder agents may read and write. */
  workspace: string
  port: number
  log?: (msg: string) => void
  /** Decodes an image file to RGBA. Defaults to the built-in PNG decoder. */
  decodeImage?: ImageDecoder
}

export interface RunningMcp {
  url: string
  port: number
  close(): Promise<void>
}

const INSTRUCTIONS = `Pixel Asset Studio is a pixel-art editor. You edit a sprite by calling drawing tools; the human sees your changes live and can undo them.

Tilesets: tileset_create, then tile_draw_from_ascii per tile, check_seams between neighbours, tilemap_preview to view a map. Workflow: (1) sprite_create with a small size (16x16 or 32x32 is plenty) and a palette preset; (2) palette_info to see the color indexes; (3) draw with draw_from_ascii for the main shapes, then draw_rect, draw_ellipse, draw_line, fill and draw_pixels to refine; (4) call render_snapshot after every few edits and LOOK at the image, then fix what is wrong; (5) export_image or export_spritesheet when done.

You can also import_image a reference picture from the workspace folder and refine it. Rules of thumb: colors are palette indexes, not RGB, and index 0 is transparent. Coordinates start at (0,0) in the top-left. Use few colors and a dark outline. Wrap a multi-step change in group_begin / group_end so the human can undo it in one step. Files are read and written inside the workspace folder only; use relative paths such as 'hero.png'.`

const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] })
const json = (v: unknown): CallToolResult => text(JSON.stringify(v, null, 2))
const fail = (e: unknown): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }]
})

/** Runs a tool body, turning any thrown error into an MCP error result the agent can read. */
async function guard(fn: () => CallToolResult | Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn()
  } catch (e) {
    return fail(e)
  }
}

const spriteRef = z.string().optional().describe('Sprite id or name. Defaults to the active sprite.')
const scaleOpt = z.number().int().min(1).max(64).optional()
const formatOpt = z.enum(IMAGE_FORMATS as [ImageFormat, ...ImageFormat[]]).optional().describe('Default png.')

function pickFormat(format: ImageFormat | undefined, path: string): ImageFormat {
  const f = format ?? (extname(path).slice(1).toLowerCase() as ImageFormat)
  if (!IMAGE_FORMATS.includes(f)) throw new CommandError(`Unsupported format '${f}'. Use ${IMAGE_FORMATS.join(', ')}.`)
  return f
}

function autoScale(w: number, h: number): number {
  return Math.max(1, Math.min(32, Math.floor(512 / Math.max(w, h))))
}

export function buildServer(opts: McpOptions): McpServer {
  const { engine, workspace } = opts
  const server = new McpServer({ name: 'pixel-asset-studio', version: '0.1.0' }, { instructions: INSTRUCTIONS })

  // Every editing command is exposed as a tool generated from its schema.
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    server.registerTool(name, { description: cmd.description, inputSchema: cmd.schema.shape }, (args) =>
      guard(() => {
        const r = engine.execute(name, args, 'agent')
        return text(`${r.summary} (revision ${r.revision})`)
      })
    )
  }

  server.registerTool(
    'group_begin',
    { description: 'Start grouping edits so the human can undo them as one step. End with group_end.', inputSchema: { label: z.string().optional() } },
    ({ label }) => guard(() => (engine.beginGroup(label ?? 'agent edit', 'agent'), text('Group started.')))
  )
  server.registerTool('group_end', { description: 'Finish the current edit group.', inputSchema: {} }, () =>
    guard(() => (engine.endGroup('agent'), text('Group ended.')))
  )
  server.registerTool('undo', { description: 'Undo the last edit or group (yours or the human\'s).', inputSchema: {} }, () =>
    guard(() => {
      const l = engine.undo('agent')
      return text(l ? `Undid ${l}.` : 'Nothing to undo.')
    })
  )
  server.registerTool('redo', { description: 'Redo the last undone edit.', inputSchema: {} }, () =>
    guard(() => {
      const l = engine.redo('agent')
      return text(l ? `Redid ${l}.` : 'Nothing to redo.')
    })
  )
  server.registerTool(
    'history_list',
    { description: 'Recent edits, newest last, with who made them (human or agent).', inputSchema: { limit: z.number().int().min(1).max(200).optional() } },
    ({ limit }) =>
      guard(() =>
        json(engine.log.slice(-(limit ?? 20)).map((e) => ({ seq: e.seq, actor: e.actor, command: e.command, summary: e.summary })))
      )
  )

  // ---- inspect ------------------------------------------------------------

  server.registerTool('project_info', { description: 'Project name, sprites, palettes and the workspace folder.', inputSchema: {} }, () =>
    guard(() => json({ ...projectInfo(engine.project), workspace, revision: engine.revision }))
  )
  server.registerTool('sprite_info', { description: 'Size, layers, frames and tags of a sprite.', inputSchema: { sprite: spriteRef } }, ({ sprite }) =>
    guard(() => json(spriteInfo(findSprite(engine.project, sprite))))
  )
  server.registerTool(
    'palette_info',
    { description: 'The sprite\'s palette: index, hex color and the ASCII character used for it in draw_from_ascii and get_pixels.', inputSchema: { sprite: spriteRef } },
    ({ sprite }) => guard(() => json(paletteInfo(engine.project, sprite)))
  )
  server.registerTool(
    'get_pixels',
    {
      description: 'Read pixels as ASCII rows (same characters as draw_from_ascii), optionally a sub-region.',
      inputSchema: {
        sprite: spriteRef,
        layer: z.union([z.string(), z.number().int()]).optional(),
        frame: z.number().int().min(0).optional(),
        x: z.number().int().min(0).optional(),
        y: z.number().int().min(0).optional(),
        width: z.number().int().min(1).optional(),
        height: z.number().int().min(1).optional()
      }
    },
    (a) =>
      guard(() => {
        const r = pixelsAscii(engine.project, a)
        return text(`${r.width}x${r.height} at (${r.x},${r.y})\n${r.rows.join('\n')}`)
      })
  )

  server.registerTool(
    'render_snapshot',
    {
      description:
        'Render one frame as an image so you can see your work. The image is upscaled with nearest-neighbour; the grid marks pixel boundaries and every 8th line is stronger, which helps you read coordinates. Use region to zoom into an area.',
      inputSchema: {
        sprite: spriteRef,
        frame: z.number().int().min(0).optional(),
        scale: scaleOpt.describe('Pixels per sprite pixel. Default: fits about 512 px.'),
        grid: z.boolean().optional().describe('Default true.'),
        background: z.string().optional().describe("'checker' (default), 'transparent' or a #rrggbb color."),
        region: z
          .object({ x: z.number().int(), y: z.number().int(), width: z.number().int().min(1), height: z.number().int().min(1) })
          .optional()
      }
    },
    (a) =>
      guard(() => {
        const s = findSprite(engine.project, a.sprite)
        let bm = renderFrame(engine.project, s, a.frame ?? 0)
        if (a.region) bm = crop(bm, a.region.x, a.region.y, a.region.width, a.region.height)
        if (bm.width === 0 || bm.height === 0) throw new CommandError('The region is outside the sprite.')
        const scale = a.scale ?? autoScale(bm.width, bm.height)
        const big = upscale(bm, { scale, grid: a.grid ?? true, background: a.background })
        const png = encodePng(big)
        return {
          content: [
            { type: 'text', text: `Sprite '${s.name}' frame ${a.frame ?? 0}, ${bm.width}x${bm.height} px shown at ${scale}x (revision ${engine.revision}).` },
            { type: 'image', data: png.toString('base64'), mimeType: 'image/png' }
          ]
        }
      })
  )

  server.registerTool(
    'render_animation_strip',
    {
      description: 'Render all frames side by side in one image to review an animation.',
      inputSchema: { sprite: spriteRef, scale: scaleOpt, grid: z.boolean().optional() }
    },
    (a) =>
      guard(() => {
        const s = findSprite(engine.project, a.sprite)
        const scale = a.scale ?? autoScale(s.width * s.frames.length, s.height)
        const strip = animationStrip(engine.project, s, { scale, grid: a.grid ?? false })
        return {
          content: [
            { type: 'text', text: `${s.frames.length} frames of ${s.width}x${s.height} at ${scale}x, left to right.` },
            { type: 'image', data: encodePng(strip).toString('base64'), mimeType: 'image/png' }
          ]
        }
      })
  )

  // ---- tilesets -----------------------------------------------------------

  server.registerTool(
    'check_seams',
    {
      description: 'Compare the touching edges of two tiles of a tileset so they join without a visible seam. side = which edge of tile a touches tile b ("right": a is left of b; "bottom": a is above b).',
      inputSchema: {
        sprite: spriteRef,
        a: z.number().int().min(0),
        b: z.number().int().min(0),
        side: z.enum(['right', 'bottom']),
        layer: z.union([z.string(), z.number().int()]).optional(),
        frame: z.number().int().min(0).optional()
      }
    },
    (a) =>
      guard(() => {
        const r = checkSeams(engine.project, a)
        return text(r.mismatches.length ? `${r.mismatches.length} of ${r.length} edge pixels differ: ${JSON.stringify(r.mismatches)}` : `Seam OK: all ${r.length} edge pixels match.`)
      })
  )

  server.registerTool(
    'tilemap_preview',
    {
      description: 'Render a map of tile numbers (rows of tile indexes; -1 = empty) using the tileset, so you can see how tiles look next to each other.',
      inputSchema: {
        sprite: spriteRef,
        map: z.array(z.array(z.number().int().min(-1))).min(1).max(64),
        scale: scaleOpt.describe('Default: fits about 512 px.'),
        grid: z.boolean().optional().describe('Draw tile boundaries. Default true.')
      }
    },
    (a) =>
      guard(() => {
        const s = findSprite(engine.project, a.sprite)
        const bm = renderTilemap(engine.project, s, a.map.map((r) => r.map((t) => (t < 0 ? null : t))))
        const scale = a.scale ?? autoScale(bm.width, bm.height)
        const big = upscale(bm, { scale, grid: false, background: 'checker' })
        if (a.grid ?? true) {
          const ts = s.tileSize as { w: number; h: number }
          for (let y = 0; y < big.height; y++)
            for (let x = 0; x < big.width; x++) {
              if (x % (ts.w * scale) === 0 || y % (ts.h * scale) === 0) {
                const o = (y * big.width + x) * 4
                big.data[o] = (big.data[o] as number) * 0.4
                big.data[o + 1] = (big.data[o + 1] as number) * 0.4
                big.data[o + 2] = (big.data[o + 2] as number) * 0.4
              }
            }
        }
        return {
          content: [
            { type: 'text', text: `Tilemap ${a.map[0]?.length ?? 0}x${a.map.length} tiles (${bm.width}x${bm.height} px) at ${scale}x.` },
            { type: 'image', data: encodePng(big).toString('base64'), mimeType: 'image/png' }
          ]
        }
      })
  )

  // ---- files --------------------------------------------------------------

  server.registerTool(
    'export_image',
    {
      description: 'Save one frame as an image file in the workspace folder. Transparent pixels stay transparent.',
      inputSchema: {
        path: z.string().describe("Relative path such as 'hero.png'."),
        sprite: spriteRef,
        frame: z.number().int().min(0).optional(),
        scale: scaleOpt.describe('Default 1.'),
        format: formatOpt
      }
    },
    (a) =>
      guard(() => {
        const format = pickFormat(a.format, a.path)
        const abs = resolveInWorkspace(workspace, a.path, ['.' + format])
        const s = findSprite(engine.project, a.sprite)
        const r = exportImageFile(engine.project, s, abs, { frame: a.frame, scale: a.scale, format })
        return text(`Saved ${r.width}x${r.height} ${format} to ${abs}`)
      })
  )

  server.registerTool(
    'export_spritesheet',
    {
      description:
        'Save all frames as one sprite sheet image plus a JSON atlas (frame rectangles, durations, tags) next to it. Works with Unity, Godot, Phaser and other engines.',
      inputSchema: {
        path: z.string().describe("Relative image path such as 'hero-sheet.png'. The atlas is written as 'hero-sheet.json'."),
        sprite: spriteRef,
        scale: scaleOpt.describe('Default 1.'),
        columns: z.number().int().min(1).optional().describe('Frames per row. Default: all in one row.'),
        format: formatOpt
      }
    },
    (a) =>
      guard(() => {
        const format = pickFormat(a.format, a.path)
        const abs = resolveInWorkspace(workspace, a.path, ['.' + format])
        const s = findSprite(engine.project, a.sprite)
        const r = exportSheetFiles(engine.project, s, abs, { scale: a.scale, columns: a.columns, format })
        return text(`Saved ${r.width}x${r.height} sheet to ${abs} and atlas to ${r.atlasPath}`)
      })
  )

  server.registerTool(
    'import_image',
    {
      description:
        'Turn an image file (PNG; other formats when the app is running) into pixel art on a sprite: downscale, map to the palette in a perceptual color space, optional dither, cleanup. With palette "auto" a new palette is derived from the picture. Creates the sprite when none is active.',
      inputSchema: {
        path: z.string().describe("Relative path in the workspace folder, e.g. 'ref/knight.png'."),
        sprite: spriteRef,
        name: z.string().optional().describe('Name for a new sprite. Default: the file name.'),
        width: z.number().int().min(1).max(512).optional().describe('Target width. Default: fit inside 32x32 keeping aspect ratio.'),
        height: z.number().int().min(1).max(512).optional(),
        fit: z.enum(['contain', 'cover', 'stretch']).optional().describe('Default contain (pad with transparency).'),
        palette: z.enum(['sprite', 'auto']).optional().describe("'sprite' maps to the sprite's palette (default); 'auto' derives colors from the image: a fresh palette for a new sprite, or an extra named group appended to an existing sprite's palette (existing frames keep their colors)."),
        newFrame: z.boolean().optional().describe('Append a new frame and import onto it instead of an existing frame. Default false.'),
        colors: z.number().int().min(2).max(64).optional().describe('Palette size for auto. Default 16.'),
        dither: z.enum(['none', 'floyd', 'ordered']).optional().describe('Default none; floyd for photos.'),
        alphaThreshold: z.number().int().min(0).max(255).optional(),
        cleanup: z.boolean().optional().describe('Remove isolated stray pixels. Default true.'),
        layer: z.union([z.string(), z.number().int()]).optional(),
        frame: z.number().int().min(0).optional(),
        x: z.number().int().optional(),
        y: z.number().int().optional()
      }
    },
    (a) =>
      guard(() => {
        const abs = resolveInWorkspace(workspace, a.path)
        const decode = opts.decodeImage ?? ((p: string) => decodePng(readFileSync(p)))
        const img = decode(abs)
        // With an explicit sprite, findSprite throws on a typo instead of silently creating a new one.
        let s = a.sprite ? findSprite(engine.project, a.sprite) : engine.project.activeSprite ? findSprite(engine.project) : undefined
        const fitBox = 32
        const scale = Math.min(1, fitBox / Math.max(img.width, img.height))
        const width = a.width ?? (s && !a.height ? s.width : Math.max(1, Math.round(img.width * scale)))
        const height = a.height ?? (s && !a.width ? s.height : Math.max(1, Math.round(img.height * scale)))
        engine.beginGroup('import_image', 'agent')
        let sCreated = false
        try {
          if (!s) {
            const name = a.name ?? basename(abs).replace(/\.[^.]+$/, '')
            engine.execute('sprite_create', { name, width, height, palette: 'db16' }, 'agent')
            s = findSprite(engine.project)
            sCreated = true
          }
          const created = sCreated
          if (a.palette === 'auto') {
            const colors = extractPalette(img, a.colors ?? 16, a.alphaThreshold)
            if (!colors.length) throw new CommandError('The image has no opaque pixels to build a palette from.')
            if (created) engine.execute('palette_set', { name: `${s.name}-auto`, colors, sprite: s.id }, 'agent')
            else engine.execute('palette_extend', { colors, group: basename(abs).replace(/\.[^.]+$/, ''), sprite: s.id }, 'agent')
          }
          let frame = a.frame
          if (a.newFrame) {
            engine.execute('frame_add', { sprite: s.id }, 'agent')
            frame = findSprite(engine.project, s.id).frames.length - 1
          }
          const pal = engine.project.palettes[findSprite(engine.project, s.id).palette]
          if (!pal) throw new CommandError('Palette missing.')
          const r = pixelate(img, pal.colors, { width, height, fit: a.fit, dither: a.dither, alphaThreshold: a.alphaThreshold, cleanup: a.cleanup })
          const res = engine.execute(
            'paste_indexed',
            { sprite: s.id, layer: a.layer, frame, x: a.x, y: a.y, width, height, data: Array.from(r.indexes) },
            'agent'
          )
          const out = text(`Imported ${img.width}x${img.height} image as ${width}x${height} pixels onto '${s.name}' (${res.changedPixels} pixels changed, revision ${res.revision}). Call render_snapshot to check it.`)
          engine.endGroup('agent')
          return out
        } catch (e) {
          engine.abortGroup('agent')
          throw e
        }
      })
  )

  server.registerTool(
    'export_gif',
    {
      description: 'Save an animated GIF of all frames, or of one tag, using each frame\'s duration. Loops forever. Transparency is kept.',
      inputSchema: {
        path: z.string().describe("Relative path such as 'hero-idle.gif'."),
        sprite: spriteRef,
        scale: scaleOpt.describe('Default 4, so the GIF is viewable at real size.'),
        tag: z.string().optional().describe('Export only this tag\'s frame range.'),
        from: z.number().int().min(0).optional(),
        to: z.number().int().min(0).optional()
      }
    },
    (a) =>
      guard(() => {
        const abs = resolveInWorkspace(workspace, a.path, ['.gif'])
        const s = findSprite(engine.project, a.sprite)
        const buf = encodeGif(engine.project, s, { scale: a.scale ?? 4, tag: a.tag, from: a.from, to: a.to })
        writeFileEnsuringDir(abs, buf)
        return text(`Saved animated GIF (${s.frames.length} frames at ${a.scale ?? 4}x) to ${abs}`)
      })
  )

  server.registerTool(
    'project_save',
    { description: `Save the whole project as a ${PROJECT_EXT} file in the workspace folder.`, inputSchema: { path: z.string() } },
    ({ path }) =>
      guard(() => {
        const abs = resolveInWorkspace(workspace, path, [PROJECT_EXT])
        saveProject(engine, abs)
        return text(`Saved project to ${abs}`)
      })
  )
  server.registerTool(
    'project_open',
    { description: `Open a ${PROJECT_EXT} file from the workspace folder. Replaces the current project and clears undo history.`, inputSchema: { path: z.string() } },
    ({ path }) =>
      guard(() => {
        const abs = resolveInWorkspace(workspace, path, [PROJECT_EXT])
        openProject(engine, abs, 'agent')
        return text(`Opened ${abs}`)
      })
  )

  return server
}

// ---- HTTP transport ---------------------------------------------------------

const MAX_BODY = 4 * 1024 * 1024

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('Request body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined)
      } catch {
        reject(new Error('Invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Only accept requests addressed to this machine: blocks DNS-rebinding and other websites' fetches. */
function isLocalRequest(req: IncomingMessage, port: number): boolean {
  const okHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
  if (!req.headers.host || !okHosts.includes(req.headers.host)) return false
  const origin = req.headers.origin
  if (origin) {
    try {
      const h = new URL(origin).hostname
      if (h !== '127.0.0.1' && h !== 'localhost' && h !== '[::1]') return false
    } catch {
      return false
    }
  }
  return true
}

export function startMcpServer(opts: McpOptions): Promise<RunningMcp> {
  const log = opts.log ?? (() => {})
  const http: Server = createServer(async (req, res) => {
    const port = (http.address() as { port: number }).port
    if (!isLocalRequest(req, port)) return send(res, 403, { error: 'Forbidden' })
    if (!req.url || new URL(req.url, 'http://x').pathname !== '/mcp') return send(res, 404, { error: 'Not found. The MCP endpoint is /mcp' })
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. POST JSON-RPC to /mcp.' }, id: null })
    }
    try {
      const body = await readBody(req)
      // Stateless: a fresh server and transport per request, so clients never hold stale sessions.
      const server = buildServer(opts)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (e) {
      log(`MCP request failed: ${e instanceof Error ? e.message : String(e)}`)
      if (!res.headersSent) send(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: e instanceof Error ? e.message : 'Bad request' }, id: null })
    }
  })

  return new Promise((resolve, reject) => {
    let attempt = 0
    const tryListen = (port: number): void => {
      http.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempt++ < 10 && opts.port !== 0) tryListen(port + 1)
        else reject(err)
      })
      http.listen(port, '127.0.0.1', () => {
        http.removeAllListeners('error')
        const actual = (http.address() as { port: number }).port
        log(`MCP server listening on http://127.0.0.1:${actual}/mcp`)
        resolve({
          url: `http://127.0.0.1:${actual}/mcp`,
          port: actual,
          close: () => new Promise<void>((r) => http.close(() => r()))
        })
      })
    }
    tryListen(opts.port)
  })
}
