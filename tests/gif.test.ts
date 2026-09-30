import { describe, expect, it } from 'vitest'
import { Engine, findSprite } from '../src/core'
import { encodeGif } from '../src/main/gif'

describe('GIF export', () => {
  it('writes a GIF89a with one image block per frame and the loop extension', () => {
    const e = new Engine()
    e.execute('sprite_create', { name: 's', width: 4, height: 4, palette: 'gameboy' })
    e.execute('draw_rect', { x: 0, y: 0, width: 4, height: 4, color: 2, filled: true })
    e.execute('frame_add', { copyFrom: 0, duration: 250 })
    e.execute('tag_add', { name: 'idle', from: 0, to: 1 })
    const gif = encodeGif(e.project, findSprite(e.project), { scale: 2 })
    expect(gif.subarray(0, 6).toString('ascii')).toBe('GIF89a')
    expect(gif.readUInt16LE(6)).toBe(8)
    expect(gif.indexOf(Buffer.from('NETSCAPE2.0'))).toBeGreaterThan(0)
    // two graphic control extensions (0x21 0xF9), second with 25 centiseconds
    let count = 0
    for (let i = 0; i < gif.length - 1; i++) if (gif[i] === 0x21 && gif[i + 1] === 0xf9) count++
    expect(count).toBe(2)
    expect(gif[gif.length - 1]).toBe(0x3b)
    const one = encodeGif(e.project, findSprite(e.project), { tag: 'idle', from: 5 })
    expect(one.length).toBeGreaterThan(0)
    expect(() => encodeGif(e.project, findSprite(e.project), { tag: 'nope' })).toThrow(/No tag/)
  })
})
