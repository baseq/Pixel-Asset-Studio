import { contextBridge, ipcRenderer } from 'electron'
import type { EngineState } from '../core'
import type { PasApi } from '../shared/api'
import { applyMessage, type StateMessage } from '../shared/delta'

// The last state we delivered, so partial (delta) messages from the main process can be merged onto it.
let current: EngineState | null = null

const api: PasApi = {
  getState: async () => {
    current = (await ipcRenderer.invoke('state:get')) as EngineState
    return current
  },
  getInfo: () => ipcRenderer.invoke('info:get'),
  command: (name, params) => ipcRenderer.invoke('cmd', name, params),
  beginGroup: (label) => ipcRenderer.invoke('group:begin', label),
  endGroup: () => ipcRenderer.invoke('group:end'),
  undo: () => ipcRenderer.invoke('undo'),
  redo: () => ipcRenderer.invoke('redo'),
  exportImage: (req) => ipcRenderer.invoke('file:export', req),
  saveProject: () => ipcRenderer.invoke('file:save'),
  openProject: () => ipcRenderer.invoke('file:open'),
  pickImage: () => ipcRenderer.invoke('file:pickImage'),
  onState: (cb) => {
    const handler = (_e: unknown, msg: StateMessage): void => {
      const next = applyMessage(current, msg)
      if (next) {
        current = next
        cb(next)
      } else {
        // Out of step (e.g. we missed a message): ask for the full state instead.
        void ipcRenderer.invoke('state:get').then((full: EngineState) => {
          current = full
          cb(full)
        })
      }
    }
    ipcRenderer.on('state', handler)
    return () => ipcRenderer.removeListener('state', handler)
  }
}

contextBridge.exposeInMainWorld('pas', api)
