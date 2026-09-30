/** A palette. colors[0] is always the transparent slot; drawable colors start at index 1. */
export interface Palette {
  name: string
  /** "#rrggbb" or "#rrggbbaa". Index 0 is "#00000000" (transparent). */
  colors: string[]
  /** Optional named ranges of indexes, e.g. colours added from an imported picture. */
  groups?: Array<{ name: string; from: number; to: number }>
}

export interface Layer {
  id: string
  name: string
  visible: boolean
  opacity: number
}

export interface Frame {
  id: string
  /** Duration in milliseconds. */
  duration: number
}

export interface Tag {
  name: string
  from: number
  to: number
}

export interface Sprite {
  id: string
  name: string
  width: number
  height: number
  /** Name of a palette in Project.palettes. */
  palette: string
  /** Bottom layer first. */
  layers: Layer[]
  frames: Frame[]
  /** Indexed pixel buffers keyed by celKey(layerId, frameId); length = width * height. */
  cels: Record<string, Uint8Array>
  tags: Tag[]
  /** Present on tilesets: the sprite is a grid of tiles this size, indexed left-to-right, top-to-bottom. */
  tileSize?: { w: number; h: number }
}

export interface Project {
  version: 1
  name: string
  palettes: Record<string, Palette>
  sprites: Sprite[]
  activeSprite: string | null
  nextId: number
}

export const celKey = (layerId: string, frameId: string): string => `${layerId}:${frameId}`

export const MAX_SIZE = 512
