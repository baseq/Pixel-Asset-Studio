import { contextBridge, ipcRenderer } from 'electron'
import type { PasApi } from '../shared/api'

const api: PasApi = {
  getState: () => ipcRenderer.invoke('state:get'),
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
    const handler = (_e: unknown, s: Parameters<typeof cb>[0]): void => cb(s)
    ipcRenderer.on('state', handler)
    return () => ipcRenderer.removeListener('state', handler)
  }
}

contextBridge.exposeInMainWorld('pas', api)
