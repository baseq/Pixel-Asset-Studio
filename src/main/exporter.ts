import { existsSync, readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { renderFrame, spriteSheet, upscale, type Project, type Sprite } from '../core'
import { encodeImage, type ImageFormat } from './encode'
import { writeFileEnsuringDir } from './files'

export interface ImageOptions {
  frame?: number
  scale?: number
  format: ImageFormat
}

/** Save one frame with transparency preserved. */
export function exportImageFile(project: Project, sprite: Sprite, abs: string, o: ImageOptions) {
  const bm = upscale(renderFrame(project, sprite, o.frame ?? 0), { scale: o.scale ?? 1, background: 'transparent' })
  writeFileEnsuringDir(abs, encodeImage(bm, o.format))
  return { width: bm.width, height: bm.height }
}

export interface SheetOptions {
  scale?: number
  columns?: number
  format: ImageFormat
}

/** Save all frames as one image plus a JSON atlas with the same base name. */
export function exportSheetFiles(project: Project, sprite: Sprite, abs: string, o: SheetOptions) {
  const scale = o.scale ?? 1
  const sheet = spriteSheet(project, sprite, scale, o.columns)
  const cols = Math.min(o.columns ?? sprite.frames.length, sprite.frames.length)
  const fw = sprite.width * scale
  const fh = sprite.height * scale
  const atlas = {
    image: basename(abs),
    size: { w: sheet.width, h: sheet.height },
    frameSize: { w: fw, h: fh },
    frames: sprite.frames.map((f, i) => ({
      index: i,
      x: (i % cols) * fw,
      y: Math.floor(i / cols) * fh,
      w: fw,
      h: fh,
      duration: f.duration
    })),
    tags: sprite.tags
  }
  const atlasPath = abs.slice(0, abs.length - extname(abs).length) + '.json'
  // Never clobber an unrelated .json that happens to sit next to the image.
  if (existsSync(atlasPath)) {
    let ours = false
    try {
      ours = 'frameSize' in JSON.parse(readFileSync(atlasPath, 'utf8'))
    } catch {
      /* not JSON, so not ours */
    }
    if (!ours) throw new Error(`Refusing to overwrite '${basename(atlasPath)}': it is not a sprite atlas written by this app.`)
  }
  writeFileEnsuringDir(abs, encodeImage(sheet, o.format))
  writeFileEnsuringDir(atlasPath, JSON.stringify(atlas, null, 2))
  return { width: sheet.width, height: sheet.height, atlasPath }
}
