import { z } from 'zod'
import { celKey, MAX_SIZE, type Layer, type Project, type Sprite } from './types'
import { asciiIndex, PRESET_NAMES, parseColor, presetPalette } from './palettes'
import { ellipsePoints, linePoints, rectPoints, type Point } from './geometry'

export class CommandError extends Error {}

export interface Cel {
  spriteId: string
  key: string
  data: Uint8Array
  width: number
  height: number
}

/** What a command may do. Implemented by the Engine, which records changes for undo. */
export interface Ctx {
  project: Project
  sprite(ref?: string): Sprite
  cel(sprite: Sprite, layer?: string | number, frame?: number): Cel
  /** Writes one pixel. Returns false when (x, y) is outside the cel. */
  put(cel: Cel, x: number, y: number, color: number): boolean
  get(cel: Cel, x: number, y: number): number
  checkColor(sprite: Sprite, color: number): void
  newId(prefix: string): string
}

export interface CommandDef {
  description: string
  schema: z.ZodObject<z.ZodRawShape>
  /** Structural commands snapshot the whole project for undo; others record pixel diffs. */
  structural: boolean
  run(ctx: Ctx, params: any): string
}

function def<S extends z.ZodObject<z.ZodRawShape>>(d: {
  description: string
  schema: S
  structural?: boolean
  run(ctx: Ctx, params: z.infer<S>): string
}): CommandDef {
  return { structural: false, ...d } as unknown as CommandDef
}

// ---- shared parameter pieces ------------------------------------------------

const spriteParam = z.string().optional().describe('Sprite id or name. Defaults to the active sprite.')
const layerParam = z
  .union([z.string(), z.number().int()])
  .optional()
  .describe('Layer index (0 = bottom) or layer name. Defaults to layer 0.')
const frameParam = z.number().int().min(0).optional().describe('Frame index, starting at 0. Defaults to 0.')
const colorParam = z
  .number()
  .int()
  .min(0)
  .max(255)
  .describe('Palette index. 0 is transparent (erases). Use palette_info to see the indexes.')
const coord = z.number().int().describe('Pixel coordinate; (0,0) is the top-left corner.')
const size = z.number().int().min(1).max(MAX_SIZE)

const drawTarget = { sprite: spriteParam, layer: layerParam, frame: frameParam }

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** Writes points with one color; returns a short description including skipped out-of-bounds pixels. */
function plot(ctx: Ctx, p: { sprite?: string; layer?: string | number; frame?: number }, color: number, pts: Point[]) {
  const sprite = ctx.sprite(p.sprite)
  ctx.checkColor(sprite, color)
  const cel = ctx.cel(sprite, p.layer, p.frame)
  let skipped = 0
  for (const [x, y] of pts) if (!ctx.put(cel, x, y, color)) skipped++
  return skipped ? ` (${plural(skipped, 'pixel')} outside the ${sprite.width}x${sprite.height} canvas skipped)` : ''
}

/** Top-left pixel of tile `i` in a tileset; throws for plain sprites or out-of-range tiles. */
export function tileOrigin(s: Sprite, i: number): { x: number; y: number } {
  if (!s.tileSize) throw new CommandError(`Sprite '${s.name}' is not a tileset. Create one with tileset_create.`)
  const cols = Math.floor(s.width / s.tileSize.w)
  const rows = Math.floor(s.height / s.tileSize.h)
  if (i < 0 || i >= cols * rows) throw new CommandError(`Tile ${i} is out of range; tileset has tiles 0..${cols * rows - 1}.`)
  return { x: (i % cols) * s.tileSize.w, y: Math.floor(i / cols) * s.tileSize.h }
}

// ---- commands ---------------------------------------------------------------

export const COMMANDS: Record<string, CommandDef> = {
  project_new: def({
    description: 'Discard the current project and start an empty one.',
    structural: true,
    schema: z.object({ name: z.string().min(1).max(80).optional() }),
    run(ctx, p) {
      ctx.project.name = p.name ?? 'Untitled'
      ctx.project.palettes = {}
      ctx.project.sprites = []
      ctx.project.activeSprite = null
      return `New project '${ctx.project.name}'`
    }
  }),

  sprite_create: def({
    description:
      'Create a sprite with one layer and one frame, and make it the active sprite. Palette presets: ' +
      PRESET_NAMES.join(', ') +
      '. Index 0 is always transparent, preset colors start at index 1.',
    structural: true,
    schema: z.object({
      name: z.string().min(1).max(80),
      width: size,
      height: size,
      palette: z.string().optional().describe('Preset name or an existing palette name. Default: db16.')
    }),
    run(ctx, p) {
      const pr = ctx.project
      if (pr.sprites.some((s) => s.name.toLowerCase() === p.name.toLowerCase()))
        throw new CommandError(`A sprite named '${p.name}' already exists.`)
      const paletteName = p.palette ?? 'db16'
      if (!pr.palettes[paletteName]) {
        if (!PRESET_NAMES.includes(paletteName))
          throw new CommandError(`Unknown palette '${paletteName}'. Presets: ${PRESET_NAMES.join(', ')}`)
        pr.palettes[paletteName] = presetPalette(paletteName)
      }
      const layer: Layer = { id: ctx.newId('L'), name: 'Layer 1', visible: true, opacity: 1 }
      const frame = { id: ctx.newId('F'), duration: 100 }
      const sprite: Sprite = {
        id: ctx.newId('S'),
        name: p.name,
        width: p.width,
        height: p.height,
        palette: paletteName,
        layers: [layer],
        frames: [frame],
        cels: { [celKey(layer.id, frame.id)]: new Uint8Array(p.width * p.height) },
        tags: []
      }
      pr.sprites.push(sprite)
      pr.activeSprite = sprite.id
      return `Created sprite '${p.name}' ${p.width}x${p.height} with palette '${paletteName}'`
    }
  }),

  tileset_create: def({
    description:
      'Create a tileset: a sprite made of a grid of equal tiles (for example 8 columns x 4 rows of 16x16). Tiles are numbered 0.. left-to-right, top-to-bottom. Use tile_draw_from_ascii to draw one tile, check_seams to test that neighbours join, tilemap_preview to see a map.',
    structural: true,
    schema: z.object({
      name: z.string().min(1).max(80),
      tileWidth: z.number().int().min(1).max(128),
      tileHeight: z.number().int().min(1).max(128),
      columns: z.number().int().min(1).max(64),
      rows: z.number().int().min(1).max(64),
      palette: z.string().optional()
    }),
    run(ctx, p) {
      const width = p.tileWidth * p.columns
      const height = p.tileHeight * p.rows
      if (width > MAX_SIZE || height > MAX_SIZE) throw new CommandError(`Tileset would be ${width}x${height}; max is ${MAX_SIZE}.`)
      const msg = (COMMANDS['sprite_create'] as CommandDef).run(ctx, { name: p.name, width, height, palette: p.palette })
      ctx.sprite(p.name).tileSize = { w: p.tileWidth, h: p.tileHeight }
      return `${msg}; tileset of ${p.columns}x${p.rows} tiles (${p.tileWidth}x${p.tileHeight} each)`
    }
  }),

  tile_draw_from_ascii: def({
    description: 'Like draw_from_ascii, but positioned on tile number `tile` of a tileset (rows should be tileHeight lines of tileWidth characters).',
    schema: z.object({
      sprite: spriteParam,
      layer: layerParam,
      frame: frameParam,
      tile: z.number().int().min(0),
      rows: z.array(z.string()).min(1).max(128),
      legend: z.record(z.string(), z.number().int().min(0).max(255)).optional()
    }),
    run(ctx, p) {
      const s = ctx.sprite(p.sprite)
      const { x, y } = tileOrigin(s, p.tile)
      return (COMMANDS['draw_from_ascii'] as CommandDef).run(ctx, { sprite: s.id, layer: p.layer, frame: p.frame, rows: p.rows, legend: p.legend, x, y })
    }
  }),

  tile_copy: def({
    description: 'Copy tile `from` onto tile `to` of a tileset (same layer and frame).',
    schema: z.object({ sprite: spriteParam, layer: layerParam, frame: frameParam, from: z.number().int().min(0), to: z.number().int().min(0) }),
    run(ctx, p) {
      const s = ctx.sprite(p.sprite)
      const a = tileOrigin(s, p.from)
      const b = tileOrigin(s, p.to)
      const ts = s.tileSize as { w: number; h: number }
      return (COMMANDS['move_region'] as CommandDef).run(ctx, { sprite: s.id, layer: p.layer, frame: p.frame, x: a.x, y: a.y, width: ts.w, height: ts.h, dx: b.x - a.x, dy: b.y - a.y, copy: true })
    }
  }),

  sprite_select: def({
    description: 'Make a sprite the active one.',
    structural: true,
    schema: z.object({ sprite: z.string() }),
    run(ctx, p) {
      const s = ctx.sprite(p.sprite)
      ctx.project.activeSprite = s.id
      return `Selected sprite '${s.name}'`
    }
  }),

  layer_add: def({
    description: 'Add a new layer on top of the stack (index = previous layer count).',
    structural: true,
    schema: z.object({ sprite: spriteParam, name: z.string().min(1).max(80).optional() }),
    run(ctx, p) {
      const s = ctx.sprite(p.sprite)
      const layer: Layer = {
        id: ctx.newId('L'),
        name: p.name ?? `Layer ${s.layers.length + 1}`,
        visible: true,
        opacity: 1
      }
      s.layers.push(layer)
      for (const f of s.frames) s.cels[celKey(layer.id, f.id)] = new Uint8Array(s.width * s.height)
      return `Added layer '${layer.name}' at index ${s.layers.length - 1}`
    }
  }),

  layer_set: def({
    description: 'Change a layer: rename it, hide or show it, or set opacity (0..1).',
    structural: true,
    schema: z.object({
      sprite: spriteParam,
      layer: z.union([z.string(), z.number().int()]),
      name: z.string().min(1).max(80).optional(),
      visible: z.boolean().optional(),
      opacity: z.number().min(0).max(1).optional()
    }),
    run(ctx, p) {
      const s = ctx.sprite(p.sprite)
      const cel = ctx.cel(s, p.layer, 0)
      const layer = s.layers.find((l) => cel.key.startsWith(l.id + ':')) as Layer
      if (p.name !== undefined) layer.name = p.name
      if (p.visible !== undefined) layer.visible = p.visible
      if (p.opacity !== undefined) layer.opacity = p.opacity
      return `Updated layer '${layer.name}'`
    }
  }),

  layer_delete: def({
    description: 'Delete a layer and its pixels on every frame. A sprite always keeps at least one layer.',
    structural: true,
    schema: z.object({ sprite: spriteParam, layer: z.union([z.string(), z.number().int()]) }),
    run(ctx, p) {
      const s = ctx.sprite(p.sprite)
      if (s.layers.length === 1) throw new CommandError('Cannot delete the only layer.')
      const cel = ctx.cel(s, p.layer, 0)
      const i = s.layers.findIndex((l) => cel.key.startsWith(l.id + ':'))
      const [layer] = s.layers.splice(i, 1)
      for (const f of s.frames) delete s.cels[celKey((layer as Layer).id, f.id)]
      return `Deleted layer '${(layer as Layer).name}'`
    }
  }),

  layer_move: def({
    description: 'Move a layer to another index in the stack (0 = bottom).',
    structural: true,
    schema: z.object({ sprite: spriteParam, layer: z.union([z.string(), z.number().int()]), to: z.number().int().min(0) }),
    run(ctx, p) {
      const s = ctx.sprite(p.sprite)
      const cel = ctx.cel(s, p.layer, 0)
      const from = s.layers.findIndex((l) => cel.key.startsWith(l.id + ':'))
      if (p.to >= s.layers.length) throw new CommandError(`to must be 0..${s.layers.length - 1}.`)
      const [layer] = s.layers.splice(from, 1)
      s.layers.splice(p.to, 0, layer as Layer)
      return `Moved layer '${(layer as Layer).name}' to index ${p.to}`
    }
  }),

  move_region: def({
    description: 'Move a rectangle of pixels by (dx, dy) on one cel, leaving transparency behind. Pixels moved off the canvas are lost.',
    schema: z.object({
      ...drawTarget,
      x: coord,
      y: coord,
      width: size,
      height: size,
      dx: z.number().int(),
      dy: z.number().int(),
      /** Copy instead of move. Default false. */
      copy: z.boolean().optional()
    }),
    run(ctx, p) {
      const s = ctx.sprite(p.sprite)
      const cel = ctx.cel(s, p.layer, p.frame)
      const buf: number[] = []
      for (let j = 0; j < p.height; j++)
        for (let i = 0; i < p.width; i++) {
          const x = p.x + i, y = p.y + j
          buf.push(x < 0 || y < 0 || x >= cel.width || y >= cel.height ? 0 : ctx.get(cel, x, y))
        }
      if (!p.copy) for (let j = 0; j < p.height; j++) for (let i = 0; i < p.width; i++) ctx.put(cel, p.x + i, p.y + j, 0)
      let skipped = 0
      for (let j = 0; j < p.height; j++)
        for (let i = 0; i < p.width; i++) {
          const v = buf[j * p.width + i] as number
          if (v === 0) continue
          if (!ctx.put(cel, p.x + i + p.dx, p.y + j + p.dy, v)) skipped++
        }
      return `${p.copy ? 'copy' : 'move'} ${p.width}x${p.height} from (${p.x},${p.y}) by (${p.dx},${p.dy})` + (skipped ? ` (${skipped} pixels lost off-canvas)` : '')
    }
  }),

  clear_region: def({
    description: 'Erase a rectangle of pixels on one cel.',
    schema: z.object({ ...drawTarget, x: coord, y: coord, width: size, height: size }),
    run(ctx, p) {
      const s = ctx.sprite(p.sprite)
      const cel = ctx.cel(s, p.layer, p.frame)
      for (let j = 0; j < p.height; j++) for (let i = 0; i < p.width; i++) ctx.put(cel, p.x + i, p.y + j, 0)
      return `clear ${p.width}x${p.height} at (${p.x},${p.y})`
    }
  }),

  frame_add: def({
    description: 'Append a frame. With copyFrom, the new frame starts as a copy of that frame; otherwise it is empty.',
    structural: true,
    schema: z.object({
      sprite: spriteParam,
      copyFrom: z.number().int().min(0).optional(),
      duration: z.number().int().min(10).max(10000).optional().describe('Milliseconds. Default 100.')
    }),
    run(ctx, p) {
      const s = ctx.sprite(p.sprite)
      const src = p.copyFrom === undefined ? undefined : s.frames[p.copyFrom]
      if (p.copyFrom !== undefined && !src)
        throw new CommandError(`copyFrom ${p.copyFrom} is out of range; sprite has ${plural(s.frames.length, 'frame')}.`)
      const frame = { id: ctx.newId('F'), duration: p.duration ?? src?.duration ?? 100 }
      s.frames.push(frame)
      for (const l of s.layers) {
        const from = src ? s.cels[celKey(l.id, src.id)] : undefined
        s.cels[celKey(l.id, frame.id)] = from ? new Uint8Array(from) : new Uint8Array(s.width * s.height)
      }
      return `Added frame ${s.frames.length - 1}${src ? ` (copy of frame ${p.copyFrom})` : ''}`
    }
  }),

  frame_set_duration: def({
    description: 'Set how long a frame is shown, in milliseconds.',
    structural: true,
    schema: z.object({
      sprite: spriteParam,
      frame: z.number().int().min(0),
      duration: z.number().int().min(10).max(10000)
    }),
    run(ctx, p) {
      const s = ctx.sprite(p.sprite)
      const f = s.frames[p.frame]
      if (!f) throw new CommandError(`Frame ${p.frame} is out of range; sprite has ${plural(s.frames.length, 'frame')}.`)
      f.duration = p.duration
      return `Frame ${p.frame} duration ${p.duration} ms`
    }
  }),

  frame_delete: def({
    description: 'Delete a frame. A sprite always keeps at least one frame. Tags are shifted or shrunk to match.',
    structural: true,
    schema: z.object({ sprite: spriteParam, frame: z.number().int().min(0) }),
    run(ctx, p) {
      const s = ctx.sprite(p.sprite)
      const f = s.frames[p.frame]
      if (!f) throw new CommandError(`Frame ${p.frame} is out of range; sprite has ${plural(s.frames.length, 'frame')}.`)
      if (s.frames.length === 1) throw new CommandError('Cannot delete the only frame.')
      s.frames.splice(p.frame, 1)
      for (const l of s.layers) delete s.cels[celKey(l.id, f.id)]
      s.tags = s.tags
        .map((t) => ({ ...t, from: t.from > p.frame ? t.from - 1 : t.from, to: t.to >= p.frame ? t.to - 1 : t.to }))
        .filter((t) => t.to >= t.from && t.from < s.frames.length)
      return `Deleted frame ${p.frame}`
    }
  }),

  frame_move: def({
    description: 'Move a frame to another position (reorder). Tags keep their index ranges.',
    structural: true,
    schema: z.object({ sprite: spriteParam, from: z.number().int().min(0), to: z.number().int().min(0) }),
    run(ctx, p) {
      const s = ctx.sprite(p.sprite)
      if (p.from >= s.frames.length || p.to >= s.frames.length)
        throw new CommandError(`Frame index out of range; sprite has ${plural(s.frames.length, 'frame')}.`)
      const [f] = s.frames.splice(p.from, 1)
      s.frames.splice(p.to, 0, f as (typeof s.frames)[number])
      return `Moved frame ${p.from} to ${p.to}`
    }
  }),

  tag_remove: def({
    description: 'Remove an animation tag by name.',
    structural: true,
    schema: z.object({ sprite: spriteParam, name: z.string().min(1) }),
    run(ctx, p) {
      const s = ctx.sprite(p.sprite)
      const n = s.tags.length
      s.tags = s.tags.filter((t) => t.name !== p.name)
      if (s.tags.length === n) throw new CommandError(`No tag named '${p.name}'. Tags: ${s.tags.map((t) => t.name).join(', ') || 'none'}.`)
      return `Removed tag '${p.name}'`
    }
  }),

  tag_add: def({
    description: 'Name a range of frames as an animation, for example idle or walk.',
    structural: true,
    schema: z.object({
      sprite: spriteParam,
      name: z.string().min(1).max(40),
      from: z.number().int().min(0),
      to: z.number().int().min(0)
    }),
    run(ctx, p) {
      const s = ctx.sprite(p.sprite)
      if (p.to < p.from || p.to >= s.frames.length)
        throw new CommandError(`Invalid range ${p.from}..${p.to}; sprite has frames 0..${s.frames.length - 1}.`)
      s.tags = s.tags.filter((t) => t.name !== p.name)
      s.tags.push({ name: p.name, from: p.from, to: p.to })
      return `Tag '${p.name}' = frames ${p.from}..${p.to}`
    }
  }),

  palette_set: def({
    description:
      'Create or replace a named palette from a list of colors (#rrggbb). Do not include the transparent slot: the first color you give becomes index 1. Optionally assign it to a sprite.',
    structural: true,
    schema: z.object({
      name: z.string().min(1).max(40),
      colors: z.array(z.string()).min(1).max(255),
      sprite: spriteParam,
      assign: z.boolean().optional().describe('Assign the palette to the sprite. Default true when a sprite exists.')
    }),
    run(ctx, p) {
      try {
        p.colors.forEach(parseColor)
      } catch (e) {
        throw new CommandError((e as Error).message)
      }
      ctx.project.palettes[p.name] = { name: p.name, colors: ['#00000000', ...p.colors] }
      const hasSprite = ctx.project.sprites.length > 0
      if (p.assign ?? hasSprite) {
        const s = ctx.sprite(p.sprite)
        s.palette = p.name
      }
      return `Palette '${p.name}' with ${plural(p.colors.length, 'color')}`
    }
  }),

  palette_extend: def({
    description:
      "Append colors to the sprite's current palette as a named group, keeping every existing index unchanged (so existing frames keep their colors). Colors already present are skipped. Use this instead of palette_set when a sprite already has art.",
    structural: true,
    schema: z.object({
      sprite: spriteParam,
      colors: z.array(z.string()).min(1).max(255),
      group: z.string().min(1).max(40).describe("Group name shown in the palette panel, e.g. 'photo'.")
    }),
    run(ctx, p) {
      try {
        p.colors.forEach(parseColor)
      } catch (e) {
        throw new CommandError((e as Error).message)
      }
      const s = ctx.sprite(p.sprite)
      const pal = ctx.project.palettes[s.palette]
      if (!pal) throw new CommandError(`Palette '${s.palette}' is missing.`)
      const existing = new Set(pal.colors.map((c) => c.toLowerCase()))
      const fresh = p.colors.filter((c) => !existing.has(c.toLowerCase()))
      if (pal.colors.length + fresh.length > 256)
        throw new CommandError(`Palette would have ${pal.colors.length + fresh.length} entries; max is 256.`)
      const from = pal.colors.length
      pal.colors.push(...fresh)
      if (fresh.length) {
        pal.groups = [...(pal.groups ?? []).filter((g) => g.name !== p.group), { name: p.group, from, to: pal.colors.length - 1 }]
      }
      return `Added ${plural(fresh.length, 'color')} to palette '${pal.name}' as group '${p.group}' (indexes ${from}..${pal.colors.length - 1})`
    }
  }),

  palette_preset: def({
    description: 'Add a built-in palette to the project and assign it to a sprite. Presets: ' + PRESET_NAMES.join(', '),
    structural: true,
    schema: z.object({ preset: z.enum(PRESET_NAMES), sprite: spriteParam }),
    run(ctx, p) {
      ctx.project.palettes[p.preset] = presetPalette(p.preset)
      const s = ctx.sprite(p.sprite)
      s.palette = p.preset
      return `Sprite '${s.name}' now uses palette '${p.preset}'`
    }
  }),

  draw_pixels: def({
    description: 'Set individual pixels. Best for touch-ups; use draw_from_ascii for whole sprites.',
    schema: z.object({
      ...drawTarget,
      pixels: z
        .array(z.object({ x: coord, y: coord, color: colorParam }))
        .min(1)
        .max(4096)
    }),
    run(ctx, p) {
      const s = ctx.sprite(p.sprite)
      for (const px of p.pixels) ctx.checkColor(s, px.color)
      const cel = ctx.cel(s, p.layer, p.frame)
      let skipped = 0
      for (const px of p.pixels) if (!ctx.put(cel, px.x, px.y, px.color)) skipped++
      return `draw_pixels ${plural(p.pixels.length, 'pixel')}` +
        (skipped ? ` (${skipped} outside the canvas skipped)` : '')
    }
  }),

  draw_line: def({
    description: 'Draw a 1-pixel line between two points (inclusive).',
    schema: z.object({ ...drawTarget, x0: coord, y0: coord, x1: coord, y1: coord, color: colorParam }),
    run: (ctx, p) =>
      `draw_line (${p.x0},${p.y0})-(${p.x1},${p.y1})` +
      plot(ctx, p, p.color, linePoints(p.x0, p.y0, p.x1, p.y1))
  }),

  draw_rect: def({
    description: 'Draw a rectangle whose top-left pixel is (x, y).',
    schema: z.object({
      ...drawTarget,
      x: coord,
      y: coord,
      width: size,
      height: size,
      color: colorParam,
      filled: z.boolean().optional().describe('Default false (outline only).')
    }),
    run: (ctx, p) =>
      `draw_rect ${p.width}x${p.height} at (${p.x},${p.y})` +
      plot(ctx, p, p.color, rectPoints(p.x, p.y, p.width, p.height, p.filled ?? false))
  }),

  draw_ellipse: def({
    description: 'Draw an ellipse inscribed in the box whose top-left pixel is (x, y).',
    schema: z.object({
      ...drawTarget,
      x: coord,
      y: coord,
      width: size,
      height: size,
      color: colorParam,
      filled: z.boolean().optional().describe('Default false (outline only).')
    }),
    run: (ctx, p) =>
      `draw_ellipse ${p.width}x${p.height} at (${p.x},${p.y})` +
      plot(ctx, p, p.color, ellipsePoints(p.x, p.y, p.width, p.height, p.filled ?? false))
  }),

  fill: def({
    description: 'Flood-fill the connected region (4-way) of same-colored pixels that contains (x, y).',
    schema: z.object({ ...drawTarget, x: coord, y: coord, color: colorParam }),
    run(ctx, p) {
      const s = ctx.sprite(p.sprite)
      ctx.checkColor(s, p.color)
      const cel = ctx.cel(s, p.layer, p.frame)
      if (p.x < 0 || p.y < 0 || p.x >= cel.width || p.y >= cel.height)
        throw new CommandError(`(${p.x},${p.y}) is outside the ${cel.width}x${cel.height} canvas.`)
      const target = ctx.get(cel, p.x, p.y)
      if (target === p.color) return 'fill: region already has that color'
      const stack: Point[] = [[p.x, p.y]]
      let n = 0
      while (stack.length) {
        const [x, y] = stack.pop() as Point
        if (x < 0 || y < 0 || x >= cel.width || y >= cel.height) continue
        if (ctx.get(cel, x, y) !== target) continue
        ctx.put(cel, x, y, p.color)
        n++
        stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1])
      }
      return `fill from (${p.x},${p.y}): ${plural(n, 'pixel')}`
    }
  }),

  draw_from_ascii: def({
    description:
      'Draw a block of pixels from text, one string per row. Default legend: "." = transparent (erases), ' +
      '"1".."9","a".."z" = palette indexes 1..35, "A".."Z" = 36..61. A space leaves the pixel unchanged. ' +
      'Use legend to map other characters to palette indexes. This is the most reliable way to draw a whole sprite.',
    schema: z.object({
      ...drawTarget,
      rows: z.array(z.string()).min(1).max(MAX_SIZE),
      x: coord.optional().describe('Left edge of the block. Default 0.'),
      y: coord.optional().describe('Top edge of the block. Default 0.'),
      legend: z
        .record(z.string(), z.number().int().min(0).max(255))
        .optional()
        .describe('Extra character-to-palette-index mappings, overriding the default legend.')
    }),
    run(ctx, p) {
      const s = ctx.sprite(p.sprite)
      const cel = ctx.cel(s, p.layer, p.frame)
      const ox = p.x ?? 0
      const oy = p.y ?? 0
      const legend = p.legend ?? {}
      // Validate everything first so a bad character changes nothing.
      const parsed: Array<[number, number, number]> = []
      p.rows.forEach((row, j) => {
        Array.from(row).forEach((ch, i) => {
          if (ch === ' ') return
          const idx = legend[ch] ?? asciiIndex(ch)
          if (idx === undefined)
            throw new CommandError(
              `Unknown character '${ch}' at row ${j}, column ${i}. Add it to legend or use the default characters.`
            )
          ctx.checkColor(s, idx)
          parsed.push([ox + i, oy + j, idx])
        })
      })
      let skipped = 0
      for (const [x, y, idx] of parsed) if (!ctx.put(cel, x, y, idx)) skipped++
      const w = Math.max(...p.rows.map((r) => Array.from(r).length))
      return `draw_from_ascii ${w}x${p.rows.length} at (${ox},${oy})` +
        (skipped ? ` (${skipped} outside the canvas skipped)` : '')
    }
  }),

  paste_indexed: def({
    description:
      'Write a block of palette indexes (row-major) at (x, y). Used by image import and by tools that compute pixels themselves. Index 0 is transparent and erases.',
    schema: z.object({
      ...drawTarget,
      x: coord.optional(),
      y: coord.optional(),
      width: size,
      height: size,
      data: z.array(z.number().int().min(0).max(255)).max(MAX_SIZE * MAX_SIZE),
      skipTransparent: z.boolean().optional().describe('Leave existing pixels where the block is transparent. Default false.')
    }),
    run(ctx, p) {
      if (p.data.length !== p.width * p.height)
        throw new CommandError(`data has ${p.data.length} values but width*height is ${p.width * p.height}.`)
      const s = ctx.sprite(p.sprite)
      for (const v of p.data) ctx.checkColor(s, v)
      const cel = ctx.cel(s, p.layer, p.frame)
      const ox = p.x ?? 0
      const oy = p.y ?? 0
      let skipped = 0
      for (let j = 0; j < p.height; j++) {
        for (let i = 0; i < p.width; i++) {
          const v = p.data[j * p.width + i] as number
          if (v === 0 && p.skipTransparent) continue
          if (!ctx.put(cel, ox + i, oy + j, v)) skipped++
        }
      }
      return `paste ${p.width}x${p.height} at (${ox},${oy})` + (skipped ? ` (${skipped} outside the canvas skipped)` : '')
    }
  }),

  clear: def({
    description: 'Erase a whole cel (one layer of one frame).',
    schema: z.object(drawTarget),
    run(ctx, p) {
      const s = ctx.sprite(p.sprite)
      const cel = ctx.cel(s, p.layer, p.frame)
      for (let y = 0; y < cel.height; y++) for (let x = 0; x < cel.width; x++) ctx.put(cel, x, y, 0)
      return 'clear'
    }
  })
}
