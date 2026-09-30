// Runs the real renderer in a plain browser with window.pas backed by an in-page Engine.
// Used for UI tests where the Electron binary is not available.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Engine } from '../../src/core'
import type { PasApi } from '../../src/shared/api'
import { App } from '../../src/renderer/src/App'
import '../../src/renderer/src/styles.css'

const engine = new Engine()
engine.execute('sprite_create', { name: 'Sprite', width: 16, height: 16, palette: 'db16' }, 'system')
;(window as any).__engine = engine

const listeners = new Set<(s: any) => void>()
// The real IPC structured-clones state; do the same so React sees a new object each time.
const snapshot = () => structuredClone(engine.getState())
engine.subscribe(() => queueMicrotask(() => listeners.forEach((cb) => cb(snapshot()))))

const api: PasApi = {
  getState: async () => snapshot(),
  getInfo: async () => ({ mcpUrl: 'http://127.0.0.1:39217/mcp', workspace: '/tmp/ws' }),
  command: async (name, params) => {
    try {
      return { ok: true, summary: engine.execute(name, params, 'human').summary }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  },
  beginGroup: async (l) => engine.beginGroup(l),
  endGroup: async () => engine.endGroup(),
  undo: async () => void engine.undo('human'),
  redo: async () => void engine.redo('human'),
  exportImage: async (r) => ((window as any).__exports = [...(((window as any).__exports) ?? []), r], null),
  saveProject: async () => null,
  openProject: async () => null,
  pickImage: async () => (window as any).__pickImage?.() ?? null,
  onState: (cb) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  }
}
window.pas = api

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
