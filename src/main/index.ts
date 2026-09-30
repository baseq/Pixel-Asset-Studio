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
import { IMAGE_FORMATS } from './encode'
import { writeFileEnsuringDir } from './files'
import { openProject, PROJECT_EXT, saveProject } from './files'
import { startMcpServer, type RunningMcp } from './mcp'

const DEFAULT_PORT = Number(process.env['PAS_MCP_PORT'] ?? 39217)

let win: BrowserWindow | null = null
let splash: BrowserWindow | null = null
let mcpReady: Promise<void> = Promise.resolve()
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

function validateExportRequest(req: ExportRequest): ExportRequest {
  const kinds = ['frame', 'sheet', 'gif']
  if (!req || !kinds.includes(req.kind)) throw new Error(`Unknown export kind '${String(req?.kind)}'.`)
  const format = req.kind === 'gif' ? 'gif' : req.format
  if (format !== 'gif' && !IMAGE_FORMATS.includes(format)) throw new Error(`Unsupported export format '${String(format)}'.`)
  const scale = req.scale ?? 1
  if (!Number.isInteger(scale) || scale < 1 || scale > 64) throw new Error('Export scale must be a whole number from 1 to 64.')
  const frame = req.frame
  if (frame !== undefined && (!Number.isInteger(frame) || frame < 0)) throw new Error('Export frame must be a non-negative integer.')
  return { ...req, format, scale, frame } as ExportRequest
}

async function chooseAndExport(raw: ExportRequest): Promise<string | null> {
  const req = validateExportRequest(raw)
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
  ipcMain.handle('info:get', async (): Promise<AppInfo> => (await mcpReady, { mcpUrl: mcp?.url ?? null, workspace }))
  ipcMain.handle('cmd', (_e, name: string, params: unknown): CommandResult => {
    try {
      return { ok: true, summary: engine.execute(name, params, 'human').summary }
    } catch (e) {
      return fail(e)
    }
  })
  ipcMain.handle('group:begin', (_e, label: string) => engine.beginGroup(label, 'human'))
  ipcMain.handle('group:end', () => engine.endGroup('human'))
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

const SPLASH_HTML = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#1b1b22;color:#e8e8ee;font-family:-apple-system,system-ui,sans-serif;-webkit-app-region:drag;user-select:none}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;border:1px solid #33333f;box-sizing:border-box}
  h1{margin:0;font-size:18px;font-weight:600;letter-spacing:.3px}
  .grid{display:grid;grid-template-columns:repeat(4,14px);gap:3px}
  .grid i{width:14px;height:14px;background:#6c7bff;opacity:.15;animation:p 1.2s infinite}
  @keyframes p{40%{opacity:1}}
  p{margin:0;font-size:12px;color:#8a8a9a}
</style>
<div class="grid">${Array.from({ length: 16 }, (_, i) => `<i style="animation-delay:${((i % 4) + Math.floor(i / 4)) * 0.12}s"></i>`).join('')}</div>
<h1>Pixel Asset Studio</h1><p>Starting…</p>`

function createSplash(): void {
  splash = new BrowserWindow({
    width: 340,
    height: 240,
    frame: false,
    resizable: false,
    movable: true,
    show: false,
    backgroundColor: '#1b1b22',
    alwaysOnTop: true,
    webPreferences: { sandbox: true, contextIsolation: true }
  })
  splash.once('ready-to-show', () => splash?.show())
  splash.on('closed', () => (splash = null))
  void splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SPLASH_HTML)}`)
}

function createWindow(): void {
  win = new BrowserWindow({
    show: false,
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
  // Reveal the real window once it has painted, then drop the splash.
  win.once('ready-to-show', () => {
    win?.show()
    splash?.close()
  })
  win.on('closed', () => (win = null))
}

app.whenReady().then(async () => {
  createSplash()
  workspace = join(app.getPath('documents'), 'PixelAssetStudio')
  mkdirSync(workspace, { recursive: true })

  if (!process.env['ELECTRON_RENDERER_URL']) {
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:"]
        }
      })
    })
  }

  registerIpc()
  broadcastSoon()
  buildMenu()
  createWindow()
  mcpReady = startMcpServer({ engine, workspace, port: DEFAULT_PORT, log: (m) => console.log(m), decodeImage })
    .then((m) => void (mcp = m))
    .catch((e) => console.error('Could not start the MCP server:', e))
  await mcpReady

  // Auto-update from GitHub Releases (only for packaged builds; dev runs skip it).
  if (app.isPackaged) {
    const { autoUpdater } = await import('electron-updater')
    autoUpdater.logger = console
    autoUpdater.autoDownload = true
    autoUpdater.on('update-downloaded', (info) => {
      void dialog
        .showMessageBox(win!, {
          type: 'info',
          buttons: ['Restart now', 'Later'],
          defaultId: 0,
          message: `Pixel Asset Studio ${info.version} is ready`,
          detail: 'The update has been downloaded and will be installed when you restart.'
        })
        .then((r) => {
          if (r.response === 0) autoUpdater.quitAndInstall()
        })
    })
    autoUpdater.on('error', (e) => console.warn('Update check failed:', e.message))
    void autoUpdater.checkForUpdates().catch(() => undefined)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => void mcp?.close())
