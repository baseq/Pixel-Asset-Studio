import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell, type MenuItemConstructorOptions } from 'electron'
import type { Bitmap } from '../core/render'
import { decodePng } from './decode'
import { Engine, CommandError, findSprite, type Project } from '../core'
import type { AppInfo, CommandResult, ExportRequest, PickedImage } from '../shared/api'
import { exportImageFile, exportSheetFiles } from './exporter'
import { encodeGif } from './gif'
import { writeFileEnsuringDir } from './files'
import { openProject, PROJECT_EXT, saveProject } from './files'
import { startMcpServer, type RunningMcp } from './mcp'

const DEFAULT_PORT = Number(process.env['PAS_MCP_PORT'] ?? 39217)

let win: BrowserWindow | null = null
let mcp: RunningMcp | null = null
let workspace = ''
let currentFile: string | null = null

/** A new project starts with one blank 32x32 sprite so the canvas is never empty. */
function starterProject(): Project {
  const e = new Engine()
  e.execute('sprite_create', { name: 'Sprite', width: 32, height: 32, palette: 'db16' }, 'system')
  return e.project
}

const engine = new Engine(starterProject())

function broadcastSoon(): void {
  let queued = false
  engine.subscribe(() => {
    if (queued) return
    queued = true
    setImmediate(() => {
      queued = false
      win?.webContents.send('state', engine.getState())
    })
  })
}

function fail(e: unknown): CommandResult {
  return { ok: false, error: e instanceof CommandError || e instanceof Error ? e.message : String(e) }
}

async function chooseAndSave(saveAs: boolean): Promise<string | null> {
  let target = currentFile
  if (saveAs || !target) {
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: join(workspace, `${engine.project.name}${PROJECT_EXT}`),
      filters: [{ name: 'Pixel Asset Studio project', extensions: [PROJECT_EXT.slice(1)] }]
    })
    if (r.canceled || !r.filePath) return null
    target = r.filePath.endsWith(PROJECT_EXT) ? r.filePath : r.filePath + PROJECT_EXT
  }
  saveProject(engine, target)
  currentFile = target
  return target
}

async function chooseAndOpen(): Promise<string | null> {
  const r = await dialog.showOpenDialog(win!, {
    defaultPath: workspace,
    properties: ['openFile'],
    filters: [{ name: 'Pixel Asset Studio project', extensions: [PROJECT_EXT.slice(1)] }]
  })
  const file = r.filePaths[0]
  if (r.canceled || !file) return null
  try {
    openProject(engine, file)
    currentFile = file
    return file
  } catch (e) {
    dialog.showErrorBox('Could not open project', e instanceof Error ? e.message : String(e))
    return null
  }
}

async function chooseAndExport(req: ExportRequest): Promise<string | null> {
  const sprite = findSprite(engine.project)
  const suffix = req.kind === 'sheet' ? '-sheet' : req.kind === 'gif' ? '-anim' : ''
  const r = await dialog.showSaveDialog(win!, {
    defaultPath: join(workspace, `${sprite.name}${suffix}.${req.format}`),
    filters: [{ name: req.format.toUpperCase(), extensions: [req.format] }]
  })
  if (r.canceled || !r.filePath) return null
  const abs = r.filePath.toLowerCase().endsWith('.' + req.format) ? r.filePath : `${r.filePath}.${req.format}`
  if (req.kind === 'gif') writeFileEnsuringDir(abs, encodeGif(engine.project, sprite, { scale: req.scale }))
  else if (req.format === 'gif') throw new Error('Use the GIF export for animations.')
  else if (req.kind === 'sheet') exportSheetFiles(engine.project, sprite, abs, { scale: req.scale, format: req.format })
  else exportImageFile(engine.project, sprite, abs, { frame: req.frame, scale: req.scale, format: req.format })
  return abs
}

/** PNG through our decoder (exact, keeps indexed/greyscale), everything else through Chromium. */
function decodeImage(path: string): Bitmap {
  if (path.toLowerCase().endsWith('.png')) {
    try {
      return decodePng(readFileSync(path))
    } catch {
      /* fall through to nativeImage for exotic PNGs */
    }
  }
  const img = nativeImage.createFromPath(path)
  if (img.isEmpty()) throw new Error(`Could not decode image '${path}'.`)
  const { width, height } = img.getSize()
  const bgra = img.toBitmap()
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = bgra[i * 4 + 2] as number
    data[i * 4 + 1] = bgra[i * 4 + 1] as number
    data[i * 4 + 2] = bgra[i * 4] as number
    data[i * 4 + 3] = bgra[i * 4 + 3] as number
  }
  return { width, height, data }
}

async function pickImage(): Promise<PickedImage | null> {
  const r = await dialog.showOpenDialog(win!, {
    defaultPath: workspace,
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
  })
  const file = r.filePaths[0]
  if (r.canceled || !file) return null
  const bm = decodeImage(file)
  if (bm.width * bm.height > 4096 * 4096) throw new Error('Image is too large (max 4096x4096).')
  return { path: file, width: bm.width, height: bm.height, data: bm.data }
}

function registerIpc(): void {
  ipcMain.handle('state:get', () => engine.getState())
  ipcMain.handle('info:get', (): AppInfo => ({ mcpUrl: mcp?.url ?? null, workspace }))
  ipcMain.handle('cmd', (_e, name: string, params: unknown): CommandResult => {
    try {
      return { ok: true, summary: engine.execute(name, params, 'human').summary }
    } catch (e) {
      return fail(e)
    }
  })
  ipcMain.handle('group:begin', (_e, label: string) => engine.beginGroup(label))
  ipcMain.handle('group:end', () => engine.endGroup())
  ipcMain.handle('undo', () => void engine.undo('human'))
  ipcMain.handle('redo', () => void engine.redo('human'))
  ipcMain.handle('file:export', (_e, req: ExportRequest) => chooseAndExport(req))
  ipcMain.handle('file:save', () => chooseAndSave(false))
  ipcMain.handle('file:open', () => chooseAndOpen())
  ipcMain.handle('file:pickImage', () => pickImage())
}

function buildMenu(): void {
  const mac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => void chooseAndOpen() },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => void chooseAndSave(false) },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => void chooseAndSave(true) },
        { type: 'separator' },
        mac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => void engine.undo('human') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => void engine.redo('human') }
      ]
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1b1b22',
    title: 'Pixel Asset Studio',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Surface renderer problems in the terminal so a blank window is never a mystery.
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') console.log(`[renderer ${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`)
  })
  win.webContents.on('preload-error', (_e, path, err) => console.error(`[preload error] ${path}: ${err.message}`))
  win.webContents.on('did-fail-load', (_e, code, desc, url) => console.error(`[load failed] ${url}: ${desc} (${code})`))
  win.webContents.on('render-process-gone', (_e, d) => console.error(`[renderer gone] ${d.reason}`))
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (dev) win.webContents.openDevTools({ mode: 'detach' })
  if (dev) void win.loadURL(dev)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  win.on('closed', () => (win = null))
}

app.whenReady().then(async () => {
  workspace = join(app.getPath('documents'), 'PixelAssetStudio')
  mkdirSync(workspace, { recursive: true })

  if (!process.env['ELECTRON_RENDERER_URL']) {
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:"]
        }
      })
    })
  }

  registerIpc()
  broadcastSoon()
  buildMenu()
  try {
    mcp = await startMcpServer({ engine, workspace, port: DEFAULT_PORT, log: (m) => console.log(m), decodeImage })
  } catch (e) {
    console.error('Could not start the MCP server:', e)
  }
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => void mcp?.close())
