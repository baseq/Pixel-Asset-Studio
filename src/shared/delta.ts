import type { Engine, EngineState } from '../core'
import { celKey } from '../core/types'

/**
 * What the main process sends to the renderer. Most updates are pencil strokes that touch one cel,
 * so instead of the whole project (every cel of every sprite) we send only the cels that changed.
 * `delta.from` is the revision the receiver must already hold for the partial state to be valid.
 */
export interface StateMessage {
  state: EngineState
  delta?: { from: number }
}

/** Drop command parameters from the log: the UI only shows summaries, and draw_pixels params can be large. */
export function forWire(state: EngineState): EngineState {
  return { ...state, log: state.log.map(({ params: _params, ...rest }) => rest) }
}

/** Build the next message and remember it as the new baseline. `lastSent` is the revision of the previous one (or -1). */
export function makeMessage(engine: Engine, lastSent: number): StateMessage {
  const dirty = engine.takeDirty()
  const state = forWire(engine.getState())
  if (dirty.all || lastSent < 0) return { state }
  return {
    state: {
      ...state,
      project: {
        ...state.project,
        sprites: state.project.sprites.map((s) => ({
          ...s,
          cels: Object.fromEntries(Object.entries(s.cels).filter(([k]) => dirty.cels.has(`${s.id}|${k}`)))
        }))
      }
    },
    delta: { from: lastSent }
  }
}

/** Apply a message on top of the state we hold. Returns null if we are out of step and need a full refetch. */
export function applyMessage(prev: EngineState | null, msg: StateMessage): EngineState | null {
  if (!msg.delta) return msg.state
  if (!prev || prev.revision !== msg.delta.from) return null
  const sprites = []
  for (const s of msg.state.project.sprites) {
    const old = prev.project.sprites.find((x) => x.id === s.id)
    const cels = { ...s.cels }
    for (const l of s.layers)
      for (const f of s.frames) {
        const k = celKey(l.id, f.id)
        if (cels[k]) continue
        const kept = old?.cels[k]
        if (!kept) return null
        cels[k] = kept
      }
    sprites.push({ ...s, cels })
  }
  return { ...msg.state, project: { ...msg.state.project, sprites } }
}
