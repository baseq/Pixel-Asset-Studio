import type { EngineState } from '../core'

export type CommandResult = { ok: true; summary: string; revision?: number } | { ok: false; error: string }

export interface ExportRequest {
  kind: 'frame' | 'sheet' | 'gif'
  format: 'png' | 'bmp' | 'gif'
  scale: number
  frame: number
}

export interface PickedImage {
  path: string
  width: number
  height: number
  /** RGBA bytes, row-major. */
  data: Uint8ClampedArray
}

export interface AppInfo {
  mcpUrl: string | null
  workspace: string
}

/** What the renderer can ask the main process to do. Exposed as window.pas by the preload script. */
export interface PasApi {
  getState(): Promise<EngineState>
  getInfo(): Promise<AppInfo>
  command(name: string, params: unknown): Promise<CommandResult>
  beginGroup(label: string): Promise<void>
  endGroup(): Promise<void>
  undo(): Promise<void>
  redo(): Promise<void>
  /** Opens a save dialog and writes the file. Resolves to the saved path, or null if cancelled. */
  exportImage(req: ExportRequest): Promise<string | null>
  saveProject(): Promise<string | null>
  openProject(): Promise<string | null>
  /** Opens a file dialog for an image and returns it decoded, or null if cancelled. */
  pickImage(): Promise<PickedImage | null>
  onState(cb: (s: EngineState) => void): () => void
}
