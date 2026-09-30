import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { parseProject, serializeProject, type Engine } from '../core'

/**
 * Agents may only read and write inside the workspace folder. Relative paths are resolved against
 * it; anything that escapes (../, absolute paths elsewhere) is refused.
 */
export function resolveInWorkspace(workspace: string, p: string, allowedExts?: string[]): string {
  const root = resolve(workspace)
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p)
  const rel = relative(root, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new Error(`Path '${p}' is outside the workspace folder (${root}). Use a relative path such as 'hero.png'.`)
  }
  if (allowedExts && !allowedExts.includes(extname(abs).toLowerCase())) {
    throw new Error(`File '${p}' must end with ${allowedExts.join(' or ')}.`)
  }
  return abs
}

export function writeFileEnsuringDir(abs: string, data: Uint8Array | string): void {
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, data)
}

export const PROJECT_EXT = '.pxs'

export function saveProject(engine: Engine, abs: string): void {
  writeFileEnsuringDir(abs, serializeProject(engine.project))
}

export function openProject(engine: Engine, abs: string, actor: 'human' | 'agent' = 'human'): void {
  engine.load(parseProject(readFileSync(abs, 'utf8')), actor)
}
