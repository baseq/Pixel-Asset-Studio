import type { z } from 'zod'
import { COMMANDS, CommandError, type Cel, type Ctx } from './commands'
import { celKey, type Layer, type Project, type Sprite } from './types'

export type Actor = 'human' | 'agent' | 'system'

export interface LogEntry {
  seq: number
  group: number
  actor: Actor
  command: string
  summary: string
  params?: unknown
  revision: number
  time: number
}

export interface ExecResult {
  revision: number
  group: number
  summary: string
  changedPixels: number
}

export interface EngineState {
  project: Project
  revision: number
  canUndo: boolean
  canRedo: boolean
  log: LogEntry[]
}

type Patch =
  | { t: 'px'; spriteId: string; key: string; idx: number[]; oldv: number[]; newv: number[] }
  | { t: 'proj'; before: Project; after: Project }

interface UndoGroup {
  id: number
  label: string
  patches: Patch[]
}

interface PixelWrites {
  spriteId: string
  key: string
  changes: Map<number, { old: number; new: number }>
}

const MAX_LOG = 2000
/** Undo history is trimmed (oldest first) once it holds more than this many bytes or groups. */
const MAX_UNDO_BYTES = 256 * 1024 * 1024
const MAX_UNDO_GROUPS = 1000

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * A structural snapshot stores every cel twice (before and after). Point unchanged cels of `after`
 * at the arrays already held by `before` so history only pays for pixels that actually changed.
 */
function shareUnchangedCels(before: Project, after: Project): void {
  for (const sa of after.sprites) {
    const sb = before.sprites.find((x) => x.id === sa.id)
    if (!sb) continue
    for (const [k, data] of Object.entries(sa.cels)) {
      const old = sb.cels[k]
      if (old && sameBytes(old, data)) sa.cels[k] = old
    }
  }
}

function patchBytes(p: Patch): number {
  if (p.t === 'px') return p.idx.length * 24
  const seen = new Set<Uint8Array>()
  let n = 0
  for (const pr of [p.before, p.after])
    for (const s of pr.sprites)
      for (const c of Object.values(s.cels))
        if (!seen.has(c)) {
          seen.add(c)
          n += c.byteLength
        }
  return n
}

export function emptyProject(name = 'Untitled'): Project {
  return { version: 1, name, palettes: {}, sprites: [], activeSprite: null, nextId: 1 }
}

export const cloneProject = (p: Project): Project => structuredClone(p)

function formatZod(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`).join('; ')
}

/**
 * The single place where a project is changed. The UI, the MCP server and tests all call
 * execute(); every change is logged and undoable.
 */
export class Engine {
  project: Project
  revision = 0
  log: LogEntry[] = []
  private undoStack: UndoGroup[] = []
  private redoStack: UndoGroup[] = []
  /** One open group per actor, so the UI and an agent can't close or merge each other's edits. */
  private open = new Map<Actor, UndoGroup>()
  private groupSeq = 0
  private seq = 0
  private listeners = new Set<() => void>()
  /** Cels written since takeDirty() was last called, as 'spriteId|celKey'. dirtyAll means structure changed. */
  private dirtyCels = new Set<string>()
  private dirtyAll = true

  constructor(project?: Project) {
    this.project = project ?? emptyProject()
  }

  /** What changed since the last call, so a UI can be sent only the cels that differ. Resets the tracker. */
  takeDirty(): { all: boolean; cels: Set<string> } {
    const out = { all: this.dirtyAll, cels: this.dirtyCels }
    this.dirtyAll = false
    this.dirtyCels = new Set()
    return out
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private notify(): void {
    for (const fn of this.listeners) fn()
  }

  getState(): EngineState {
    return {
      project: this.project,
      revision: this.revision,
      canUndo: this.undoStack.length > 0 || [...this.open.values()].some((g) => g.patches.length > 0),
      canRedo: this.redoStack.length > 0,
      log: this.log.slice(-200)
    }
  }

  /** Replace the whole project (open file). Clears history. */
  load(project: Project, actor: Actor = 'system'): void {
    this.project = project
    this.undoStack = []
    this.redoStack = []
    this.open.clear()
    this.dirtyAll = true
    this.revision++
    this.record(actor, 'project_load', `Loaded project '${project.name}'`, this.groupSeq + 1)
    this.notify()
  }

  beginGroup(label = 'group', actor: Actor = 'human'): void {
    this.endGroup(actor)
    this.open.set(actor, { id: ++this.groupSeq, label, patches: [] })
  }

  endGroup(actor: Actor = 'human'): void {
    const g = this.open.get(actor)
    this.open.delete(actor)
    if (g && g.patches.length) this.pushUndo(g)
    this.notify()
  }

  /** Close the actor's open group and roll back everything it changed (used when a batch fails midway). */
  abortGroup(actor: Actor = 'human'): void {
    const g = this.open.get(actor)
    this.open.delete(actor)
    if (g && g.patches.length) {
      for (let i = g.patches.length - 1; i >= 0; i--) this.apply(g.patches[i] as Patch, 'undo')
      this.revision++
      this.record(actor, 'abort', `Rolled back ${g.label}`, g.id)
    }
    this.notify()
  }

  private pushUndo(g: UndoGroup): void {
    this.undoStack.push(g)
    let bytes = 0
    for (const x of this.undoStack) for (const p of x.patches) bytes += patchBytes(p)
    while (this.undoStack.length > 1 && (bytes > MAX_UNDO_BYTES || this.undoStack.length > MAX_UNDO_GROUPS)) {
      const dropped = this.undoStack.shift() as UndoGroup
      for (const p of dropped.patches) bytes -= patchBytes(p)
    }
  }

  execute(name: string, params: unknown, actor: Actor = 'human'): ExecResult {
    const cmd = COMMANDS[name]
    if (!cmd) throw new CommandError(`Unknown command '${name}'. Available: ${Object.keys(COMMANDS).join(', ')}`)
    const parsed = cmd.schema.safeParse(params ?? {})
    if (!parsed.success) throw new CommandError(`Invalid parameters for ${name}: ${formatZod(parsed.error)}`)

    const writes = new Map<string, PixelWrites>()
    const before = cmd.structural ? cloneProject(this.project) : null
    let summary: string
    try {
      summary = cmd.run(this.makeCtx(writes), parsed.data)
    } catch (e) {
      // Roll back anything the failed command already changed.
      if (before) this.project = before
      else this.revert(writes)
      throw e
    }

    const patches: Patch[] = []
    let changedPixels = 0
    if (before) {
      this.dirtyAll = true
      const after = cloneProject(this.project)
      shareUnchangedCels(before, after)
      patches.push({ t: 'proj', before, after })
    } else {
      for (const w of writes.values()) {
        const idx: number[] = []
        const oldv: number[] = []
        const newv: number[] = []
        for (const [i, c] of w.changes) {
          if (c.old === c.new) continue
          idx.push(i)
          oldv.push(c.old)
          newv.push(c.new)
        }
        if (idx.length) {
          this.dirtyCels.add(`${w.spriteId}|${w.key}`)
          patches.push({ t: 'px', spriteId: w.spriteId, key: w.key, idx, oldv, newv })
          changedPixels += idx.length
        }
      }
    }

    let group: number
    if (patches.length) {
      const open = this.open.get(actor)
      if (open) {
        open.patches.push(...patches)
        group = open.id
      } else {
        group = ++this.groupSeq
        this.pushUndo({ id: group, label: name, patches })
      }
      this.redoStack = []
    } else {
      group = this.open.get(actor)?.id ?? ++this.groupSeq
    }

    this.revision++
    const text = cmd.structural ? summary : `${summary}: ${changedPixels ? plural(changedPixels) : 'no change'}`
    this.record(actor, name, text, group, params)
    this.notify()
    return { revision: this.revision, group, summary: text, changedPixels }
  }

  undo(actor: Actor = 'human'): string | null {
    this.endGroup(actor)
    const g = this.undoStack.pop()
    if (!g) return null
    for (let i = g.patches.length - 1; i >= 0; i--) this.apply(g.patches[i] as Patch, 'undo')
    this.redoStack.push(g)
    this.revision++
    this.record(actor, 'undo', `Undid ${g.label}`, g.id)
    this.notify()
    return g.label
  }

  redo(actor: Actor = 'human'): string | null {
    const g = this.redoStack.pop()
    if (!g) return null
    for (const p of g.patches) this.apply(p, 'redo')
    this.undoStack.push(g)
    this.revision++
    this.record(actor, 'redo', `Redid ${g.label}`, g.id)
    this.notify()
    return g.label
  }

  // ---- internals ----------------------------------------------------------

  private record(actor: Actor, command: string, summary: string, group: number, params?: unknown): void {
    this.log.push({ seq: ++this.seq, group, actor, command, summary, params, revision: this.revision, time: Date.now() })
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG)
  }

  private revert(writes: Map<string, PixelWrites>): void {
    for (const w of writes.values()) {
      const data = this.project.sprites.find((s) => s.id === w.spriteId)?.cels[w.key]
      if (data) for (const [i, c] of w.changes) data[i] = c.old
    }
  }

  private apply(p: Patch, dir: 'undo' | 'redo'): void {
    if (p.t === 'proj') {
      this.project = cloneProject(dir === 'undo' ? p.before : p.after)
      this.dirtyAll = true
      return
    }
    this.dirtyCels.add(`${p.spriteId}|${p.key}`)
    const data = this.project.sprites.find((s) => s.id === p.spriteId)?.cels[p.key]
    if (!data) return
    const vals = dir === 'undo' ? p.oldv : p.newv
    p.idx.forEach((pixel, k) => {
      data[pixel] = vals[k] as number
    })
  }

  private makeCtx(writes: Map<string, PixelWrites>): Ctx {
    const engine = this
    return {
      project: this.project,

      sprite(ref) {
        const pr = engine.project
        const key = ref ?? pr.activeSprite
        if (key === null || key === undefined)
          throw new CommandError('There is no active sprite. Call sprite_create first.')
        const s =
          pr.sprites.find((x) => x.id === key) ??
          pr.sprites.find((x) => x.name.toLowerCase() === String(key).toLowerCase())
        if (!s) {
          const names = pr.sprites.map((x) => `'${x.name}'`).join(', ') || 'none yet'
          throw new CommandError(`Sprite '${key}' not found. Existing sprites: ${names}.`)
        }
        return s
      },

      cel(sprite: Sprite, layerRef?: string | number, frameIdx = 0): Cel {
        let layer: Layer | undefined
        if (layerRef === undefined) layer = sprite.layers[0]
        else if (typeof layerRef === 'number') layer = sprite.layers[layerRef]
        else
          layer =
            sprite.layers.find((l) => l.id === layerRef) ??
            sprite.layers.find((l) => l.name.toLowerCase() === layerRef.toLowerCase())
        if (!layer) {
          const names = sprite.layers.map((l, i) => `${i}='${l.name}'`).join(', ')
          throw new CommandError(`Layer '${layerRef}' not found. Layers: ${names}.`)
        }
        const frame = sprite.frames[frameIdx]
        if (!frame)
          throw new CommandError(`Frame ${frameIdx} is out of range; sprite has frames 0..${sprite.frames.length - 1}.`)
        const key = celKey(layer.id, frame.id)
        const data = sprite.cels[key]
        if (!data) throw new CommandError(`Internal error: missing pixel data for layer '${layer.name}' frame ${frameIdx}.`)
        return { spriteId: sprite.id, key, data, width: sprite.width, height: sprite.height }
      },

      put(cel, x, y, color) {
        if (x < 0 || y < 0 || x >= cel.width || y >= cel.height) return false
        const i = y * cel.width + x
        const old = cel.data[i] as number
        if (old === color) return true
        const k = `${cel.spriteId}|${cel.key}`
        let w = writes.get(k)
        if (!w) {
          w = { spriteId: cel.spriteId, key: cel.key, changes: new Map() }
          writes.set(k, w)
        }
        const prev = w.changes.get(i)
        if (prev) prev.new = color
        else w.changes.set(i, { old, new: color })
        cel.data[i] = color
        return true
      },

      get: (cel, x, y) => cel.data[y * cel.width + x] as number,

      checkColor(sprite, color) {
        const pal = engine.project.palettes[sprite.palette]
        if (!pal) throw new CommandError(`Palette '${sprite.palette}' is missing.`)
        if (color >= pal.colors.length)
          throw new CommandError(
            `Color index ${color} is out of range: palette '${pal.name}' has indexes 0..${pal.colors.length - 1}.`
          )
      },

      newId(prefix) {
        return `${prefix}${engine.project.nextId++}`
      }
    }
  }
}

const plural = (n: number): string => `${n} pixel${n === 1 ? '' : 's'} changed`
