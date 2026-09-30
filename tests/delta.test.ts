import { describe, expect, it } from 'vitest'
import { Engine, pixelsAscii } from '../src/core'
import { applyMessage, forWire, makeMessage } from '../src/shared/delta'

/** Plays the roles of main (makeMessage, structured-clone over IPC) and preload (applyMessage). */
function link(e: Engine) {
  let lastSent = -1
  let held = null as ReturnType<typeof forWire> | null
  return {
    sync() {
      const msg = structuredClone(makeMessage(e, lastSent))
      lastSent = e.revision
      const next = applyMessage(held, msg)
      expect(next, 'delta should apply cleanly').not.toBeNull()
      held = next
      return { msg, state: next as ReturnType<typeof forWire> }
    }
  }
}

describe('state deltas', () => {
  it('sends only the changed cel for a pencil stroke and reconstructs the full state', () => {
    const e = new Engine()
    e.execute('sprite_create', { name: 'a', width: 4, height: 4, palette: 'pico8' }, 'agent')
    e.execute('frame_add', {}, 'agent')
    const l = link(e)
    l.sync() // full
    e.execute('draw_pixels', { pixels: [{ x: 1, y: 1, color: 3 }], frame: 1 }, 'human')
    const { msg, state } = l.sync()
    expect(msg.delta).toBeDefined()
    const sent = Object.keys(msg.state.project.sprites[0]!.cels)
    expect(sent).toHaveLength(1)
    expect(state.project).toEqual(e.project)
    expect(pixelsAscii(state.project, { frame: 1 }).rows[1]).toBe('.3..')
  })

  it('sends full state after structural changes and undo of them', () => {
    const e = new Engine()
    e.execute('sprite_create', { name: 'a', width: 4, height: 4, palette: 'pico8' }, 'agent')
    const l = link(e)
    l.sync()
    e.execute('layer_add', { name: 'x' }, 'agent')
    expect(l.sync().msg.delta).toBeUndefined()
    e.undo()
    const { msg, state } = l.sync()
    expect(msg.delta).toBeUndefined()
    expect(state.project).toEqual(e.project)
  })

  it('tracks pixel undo/redo and rolled-back groups', () => {
    const e = new Engine()
    e.execute('sprite_create', { name: 'a', width: 4, height: 4, palette: 'pico8' }, 'agent')
    const l = link(e)
    l.sync()
    e.execute('draw_pixels', { pixels: [{ x: 0, y: 0, color: 2 }] })
    expect(l.sync().state.project).toEqual(e.project)
    e.undo()
    expect(l.sync().state.project).toEqual(e.project)
    e.redo()
    expect(l.sync().state.project).toEqual(e.project)
    e.beginGroup('g', 'agent')
    e.execute('draw_pixels', { pixels: [{ x: 3, y: 3, color: 5 }] }, 'agent')
    e.abortGroup('agent')
    expect(l.sync().state.project).toEqual(e.project)
  })

  it('asks for a refetch when out of step, and drops log params', () => {
    const e = new Engine()
    e.execute('sprite_create', { name: 'a', width: 4, height: 4, palette: 'pico8' }, 'agent')
    makeMessage(e, -1)
    e.execute('draw_pixels', { pixels: [{ x: 0, y: 0, color: 2 }] })
    const msg = makeMessage(e, e.revision - 1)
    expect(applyMessage(null, msg)).toBeNull()
    expect(msg.state.log.every((x) => !('params' in x))).toBe(true)
  })
})
