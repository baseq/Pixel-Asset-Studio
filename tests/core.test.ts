import { describe, expect, it } from 'vitest'
import {
  Engine,
  CommandError,
  parseProject,
  serializeProject,
  renderFrame,
  upscale,
  spriteSheet,
  pixelsAscii,
  findSprite
} from '../src/core'
import { encodePng, encodeBmp } from '../src/main/encode'

function fresh(w = 8, h = 8) {
  const e = new Engine()
  e.execute('sprite_create', { name: 'hero', width: w, height: h, palette: 'pico8' }, 'agent')
  return e
}

describe('drawing', () => {
  it('draws from ascii and reads it back identically', () => {
    const e = fresh(4, 3)
    const rows = ['.12.', '1ff1', '.12.']
    e.execute('draw_from_ascii', { rows })
    expect(pixelsAscii(e.project, {}).rows).toEqual(rows)
  })

  it('space leaves pixels unchanged, dot erases', () => {
    const e = fresh(3, 1)
    e.execute('draw_from_ascii', { rows: ['111'] })
    e.execute('draw_from_ascii', { rows: [' . '] })
    expect(pixelsAscii(e.project, {}).rows).toEqual(['1.1'])
  })

  it('rejects unknown characters without changing anything', () => {
    const e = fresh(3, 1)
    expect(() => e.execute('draw_from_ascii', { rows: ['1?1'] })).toThrow(CommandError)
    // '?' is not in the legend, and the valid '1's before it must not have been drawn
    expect(pixelsAscii(e.project, {}).rows).toEqual(['...'])
  })

  it('rejects colors outside the palette and leaves the sprite untouched', () => {
    const e = fresh(4, 4)
    expect(() => e.execute('draw_pixels', { pixels: [{ x: 0, y: 0, color: 1 }, { x: 1, y: 0, color: 99 }] })).toThrow(
      /out of range/
    )
    expect(pixelsAscii(e.project, {}).rows[0]).toBe('....')
  })

  it('draws lines, rects, ellipses and fills', () => {
    const e = fresh(8, 8)
    e.execute('draw_line', { x0: 0, y0: 0, x1: 7, y1: 7, color: 2 })
    expect(pixelsAscii(e.project, {}).rows[3]?.[3]).toBe('2')
    e.execute('draw_rect', { x: 0, y: 0, width: 8, height: 8, color: 3, filled: true })
    expect(pixelsAscii(e.project, {}).rows.every((r) => r === '33333333')).toBe(true)
    e.execute('draw_ellipse', { x: 0, y: 0, width: 8, height: 8, color: 5, filled: true })
    expect(pixelsAscii(e.project, {}).rows[0]?.[0]).toBe('3') // corner outside the ellipse
    expect(pixelsAscii(e.project, {}).rows[4]?.[4]).toBe('5')
    e.execute('fill', { x: 0, y: 0, color: 7 })
    expect(pixelsAscii(e.project, {}).rows[0]?.[0]).toBe('7')
    expect(pixelsAscii(e.project, {}).rows[4]?.[4]).toBe('5') // separate region untouched
  })

  it('skips out-of-bounds pixels and says so', () => {
    const e = fresh(4, 4)
    const r = e.execute('draw_pixels', { pixels: [{ x: 0, y: 0, color: 1 }, { x: 10, y: 10, color: 1 }] })
    expect(r.summary).toMatch(/skipped/)
    expect(r.changedPixels).toBe(1)
  })
})

describe('undo, redo and groups', () => {
  it('undoes and redoes a pixel command', () => {
    const e = fresh(4, 4)
    e.execute('draw_rect', { x: 0, y: 0, width: 4, height: 4, color: 2, filled: true })
    e.undo()
    expect(pixelsAscii(e.project, {}).rows[0]).toBe('....')
    e.redo()
    expect(pixelsAscii(e.project, {}).rows[0]).toBe('2222')
  })

  it('undoes a whole group as one step', () => {
    const e = fresh(4, 4)
    e.beginGroup('face')
    e.execute('draw_pixels', { pixels: [{ x: 0, y: 0, color: 1 }] })
    e.execute('draw_pixels', { pixels: [{ x: 1, y: 0, color: 1 }] })
    e.endGroup()
    e.undo()
    expect(pixelsAscii(e.project, {}).rows[0]).toBe('....')
    expect(e.getState().canUndo).toBe(true) // sprite_create is still undoable
  })

  it('undoes structural commands', () => {
    const e = fresh(4, 4)
    e.execute('layer_add', { name: 'Outline' })
    expect(findSprite(e.project).layers).toHaveLength(2)
    e.undo()
    expect(findSprite(e.project).layers).toHaveLength(1)
    e.undo()
    expect(e.project.sprites).toHaveLength(0)
  })

  it('a new edit clears the redo stack', () => {
    const e = fresh(4, 4)
    e.execute('draw_pixels', { pixels: [{ x: 0, y: 0, color: 1 }] })
    e.undo()
    e.execute('draw_pixels', { pixels: [{ x: 1, y: 1, color: 2 }] })
    expect(e.getState().canRedo).toBe(false)
  })

  it('a no-op draw does not create an undo step', () => {
    const e = fresh(4, 4)
    e.execute('draw_pixels', { pixels: [{ x: 0, y: 0, color: 0 }] })
    e.undo() // undoes sprite_create, not the no-op
    expect(e.project.sprites).toHaveLength(0)
  })
})

describe('frames, layers and rendering', () => {
  it('copies a frame and renders each independently', () => {
    const e = fresh(2, 1)
    e.execute('draw_from_ascii', { rows: ['12'] })
    e.execute('frame_add', { copyFrom: 0 })
    e.execute('draw_pixels', { frame: 1, pixels: [{ x: 0, y: 0, color: 3 }] })
    expect(pixelsAscii(e.project, { frame: 0 }).rows).toEqual(['12'])
    expect(pixelsAscii(e.project, { frame: 1 }).rows).toEqual(['32'])
  })

  it('layers composite bottom to top and hidden layers are skipped', () => {
    const e = fresh(1, 1)
    e.execute('layer_add', { name: 'top' })
    e.execute('draw_pixels', { layer: 0, pixels: [{ x: 0, y: 0, color: 2 }] }) // pico8 #1d2b53
    e.execute('draw_pixels', { layer: 'top', pixels: [{ x: 0, y: 0, color: 9 }] }) // #ff004d
    const s = findSprite(e.project)
    expect(Array.from(renderFrame(e.project, s, 0).data)).toEqual([255, 0, 77, 255])
    e.execute('layer_set', { layer: 'top', visible: false })
    expect(Array.from(renderFrame(e.project, s, 0).data)).toEqual([0x1d, 0x2b, 0x53, 255])
  })

  it('upscales with nearest neighbour and a grid', () => {
    const e = fresh(2, 2)
    e.execute('draw_pixels', { pixels: [{ x: 0, y: 0, color: 9 }] })
    const s = findSprite(e.project)
    const big = upscale(renderFrame(e.project, s, 0), { scale: 8, grid: true, background: '#000000' })
    expect(big.width).toBe(16)
    expect(big.height).toBe(16)
    // pixel well inside the first cell is the sprite color
    const o = (4 * 16 + 4) * 4
    expect(Array.from(big.data.slice(o, o + 4))).toEqual([255, 0, 77, 255])
  })

  it('builds a sprite sheet', () => {
    const e = fresh(2, 2)
    e.execute('frame_add', { copyFrom: 0 })
    e.execute('frame_add', { copyFrom: 0 })
    const s = findSprite(e.project)
    const sheet = spriteSheet(e.project, s, 1, 2)
    expect(sheet.width).toBe(4)
    expect(sheet.height).toBe(4)
  })
})

describe('files', () => {
  it('round-trips through JSON', () => {
    const e = fresh(5, 3)
    e.execute('draw_from_ascii', { rows: ['12345', 'abcde', '.....'] })
    e.execute('frame_add', { copyFrom: 0 })
    const json = serializeProject(e.project)
    const back = parseProject(json)
    expect(serializeProject(back)).toBe(json)
    expect(pixelsAscii(back, {}).rows).toEqual(['12345', 'abcde', '.....'])
  })

  it('encodes valid PNG and BMP headers', () => {
    const e = fresh(3, 2)
    const bm = renderFrame(e.project, findSprite(e.project), 0)
    const png = encodePng(bm)
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG')
    expect(png.readUInt32BE(16)).toBe(3)
    expect(png.readUInt32BE(20)).toBe(2)
    const bmp = encodeBmp(bm)
    expect(bmp.subarray(0, 2).toString('ascii')).toBe('BM')
    expect(bmp.length).toBe(54 + 3 * 2 * 4)
  })
})

describe('frame editing and tags', () => {
  it('deletes and moves frames, keeping tags consistent', () => {
    const e = fresh(2, 1)
    e.execute('draw_from_ascii', { rows: ['11'] })
    e.execute('frame_add', {})
    e.execute('draw_from_ascii', { frame: 1, rows: ['22'] })
    e.execute('frame_add', {})
    e.execute('draw_from_ascii', { frame: 2, rows: ['33'] })
    e.execute('tag_add', { name: 'idle', from: 0, to: 2 })
    e.execute('frame_move', { from: 2, to: 0 })
    expect(pixelsAscii(e.project, { frame: 0 }).rows).toEqual(['33'])
    e.execute('frame_delete', { frame: 0 })
    const s = findSprite(e.project)
    expect(s.frames).toHaveLength(2)
    expect(s.tags[0]).toMatchObject({ from: 0, to: 1 })
    expect(pixelsAscii(e.project, { frame: 0 }).rows).toEqual(['11'])
    e.execute('tag_remove', { name: 'idle' })
    expect(s.tags).toHaveLength(0)
    e.undo()
    expect(findSprite(e.project).tags).toHaveLength(1)
    expect(() => e.execute('frame_delete', { frame: 0 }) && e.execute('frame_delete', { frame: 0 })).toThrow(/only frame/)
  })
})

describe('layers and regions', () => {
  it('deletes, reorders and keeps at least one layer', () => {
    const e = fresh(2, 2)
    e.execute('layer_add', { name: 'B' })
    e.execute('layer_add', { name: 'C' })
    e.execute('layer_move', { layer: 'C', to: 0 })
    expect(findSprite(e.project).layers.map((l) => l.name)).toEqual(['C', 'Layer 1', 'B'])
    e.execute('layer_delete', { layer: 1 })
    expect(findSprite(e.project).layers.map((l) => l.name)).toEqual(['C', 'B'])
    e.execute('layer_delete', { layer: 0 })
    expect(() => e.execute('layer_delete', { layer: 0 })).toThrow(/only layer/)
  })

  it('moves and copies regions', () => {
    const e = fresh(6, 2)
    e.execute('draw_from_ascii', { rows: ['12....', '34....'] })
    e.execute('move_region', { x: 0, y: 0, width: 2, height: 2, dx: 3, dy: 0 })
    expect(pixelsAscii(e.project, {}).rows).toEqual(['...12.', '...34.'])
    e.execute('move_region', { x: 3, y: 0, width: 2, height: 2, dx: -3, dy: 0, copy: true })
    expect(pixelsAscii(e.project, {}).rows).toEqual(['12.12.', '34.34.'])
    e.execute('clear_region', { x: 0, y: 0, width: 2, height: 2 })
    expect(pixelsAscii(e.project, {}).rows).toEqual(['...12.', '...34.'])
    e.undo()
    expect(pixelsAscii(e.project, {}).rows).toEqual(['12.12.', '34.34.'])
  })
})

describe('undo groups and history', () => {
  it('keeps an agent group open when the human begins and ends their own', () => {
    const e = fresh(4, 4)
    e.beginGroup('agent work', 'agent')
    e.execute('draw_pixels', { pixels: [{ x: 0, y: 0, color: 1 }] }, 'agent')
    e.beginGroup('human stroke', 'human')
    e.execute('draw_pixels', { pixels: [{ x: 1, y: 0, color: 2 }] }, 'human')
    e.endGroup('human')
    e.execute('draw_pixels', { pixels: [{ x: 2, y: 0, color: 3 }] }, 'agent')
    e.endGroup('agent')
    e.undo() // the agent group, pushed last, undoes both agent pixels
    expect(pixelsAscii(e.project, {}).rows[0]).toBe('.2..')
    e.undo() // the human stroke
    expect(pixelsAscii(e.project, {}).rows[0]).toBe('....')
  })

  it('abortGroup rolls back everything in the group', () => {
    const e = fresh(4, 4)
    e.beginGroup('batch', 'agent')
    e.execute('layer_add', { name: 'Extra' }, 'agent')
    e.execute('draw_pixels', { pixels: [{ x: 0, y: 0, color: 1 }] }, 'agent')
    e.abortGroup('agent')
    expect(findSprite(e.project).layers).toHaveLength(1)
    expect(pixelsAscii(e.project, {}).rows[0]).toBe('....')
  })

  it('structural undo snapshots share unchanged pixel data', () => {
    const e = fresh(64, 64)
    for (let i = 0; i < 5; i++) e.execute('layer_add', { name: `L${i}` })
    for (let i = 0; i < 5; i++) e.undo()
    expect(findSprite(e.project).layers).toHaveLength(1)
    for (let i = 0; i < 5; i++) e.redo()
    expect(findSprite(e.project).layers).toHaveLength(6)
  })
})

describe('project validation', () => {
  it('round-trips a valid project', () => {
    const e = fresh(5, 4)
    e.execute('draw_from_ascii', { rows: ['.1.2.', '12121', '.....', '1...2'] })
    const back = parseProject(serializeProject(e.project))
    expect(pixelsAscii(back, {}).rows).toEqual(['.1.2.', '12121', '.....', '1...2'])
  })

  it('rejects files with missing or inconsistent data', () => {
    const e = fresh(2, 2)
    const good = JSON.parse(serializeProject(e.project))
    const bad = (mutate: (f: any) => void) => {
      const f = structuredClone(good)
      mutate(f)
      return () => parseProject(JSON.stringify(f))
    }
    expect(bad((f) => delete f.palettes)).toThrow(/palettes/)
    expect(bad((f) => (f.sprites[0].cels = {}))).toThrow(/missing pixel data/)
    expect(bad((f) => (f.sprites[0].palette = 'nope'))).toThrow(/unknown palette/)
    expect(bad((f) => (f.activeSprite = 'ghost'))).toThrow(/activeSprite/)
    expect(bad((f) => (f.sprites[0].cels[Object.keys(f.sprites[0].cels)[0]!] = ['zzzz', '0000']))).toThrow(/non-hex/)
    expect(bad((f) => (f.sprites[0].cels[Object.keys(f.sprites[0].cels)[0]!] = ['ffff', '0000']))).toThrow(/color index/)
  })
})
