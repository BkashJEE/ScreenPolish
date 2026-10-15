// App settings persisted in userData/settings.json. Read through getters so a
// change takes effect for every caller without restarting.

import * as fs from 'node:fs'
import { defaultLookIn } from './looks'
import type { Look } from '@shared/presets'
import * as path from 'node:path'
import { app } from 'electron'
import { CURSOR_SKINS, DEFAULT_CURSOR_SKIN, LEGACY_CURSOR_SKINS, type AppSettings, type CursorMode, type CursorSkin } from '@shared/ipc'
import { DEFAULT_SHORTCUTS, validateShortcuts } from '@shared/shortcuts'

const FILE = 'settings.json'

let cache: AppSettings | null = null

function file(): string {
  return path.join(app.getPath('userData'), FILE)
}

/**
 * Where recordings land when nothing is configured.
 *
 * `POLISH_RECORDINGS_ROOT` overrides it in a development run, so an automated
 * test (including the self test, which deliberately uses its own userData and
 * therefore never sees the app's settings) records into a scratch folder
 * instead of the owner's library. Ignored in a packaged build.
 */
/** Where the music shelf lives: one folder, beside the rest of your music. */
export function defaultMusicRoot(): string {
  return path.join(app.getPath('music'), 'ScreenPolish')
}

/** Your own backgrounds: pictures here appear in the editor's Background panel. */
export function defaultBackgroundsRoot(): string {
  return path.join(app.getPath('pictures'), 'ScreenPolish')
}

export function defaultRecordingsRoot(): string {
  const override = process.env.POLISH_RECORDINGS_ROOT?.trim()
  if (override && path.isAbsolute(override) && !app.isPackaged) return path.normalize(override)
  return path.join(app.getPath('videos'), 'ScreenPolish')
}

/** Accept only an absolute, existing-or-creatable directory path; anything else falls back to the default. */
export function sanitizeSettings(raw: unknown, fallbackRoot: string): AppSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof AppSettings, unknown>>
  const root = typeof r.recordingsRoot === 'string' && path.isAbsolute(r.recordingsRoot.trim()) ? path.normalize(r.recordingsRoot.trim()) : fallbackRoot
  // Hyprland's portal capture omits its visible cursor, so Linux must redraw
  // the tracked pointer. macOS still captures the real pointer as-is.
  const mode: CursorMode = process.platform === 'linux' ? 'overlay' : process.platform !== 'win32' || r.cursorMode === 'system' ? 'system' : 'overlay'
  // Older names (the pack's `hermes`, and the record panel's own arrow-dark,
  // ring and crosshair) become the pointer they were drawn as in the editor.
  const rawSkin = typeof r.cursorSkin === 'string' ? (LEGACY_CURSOR_SKINS[r.cursorSkin] ?? r.cursorSkin) : r.cursorSkin
  const skin: CursorSkin = CURSOR_SKINS.includes(rawSkin as CursorSkin) ? (rawSkin as CursorSkin) : DEFAULT_CURSOR_SKIN
  let shortcuts = { ...DEFAULT_SHORTCUTS }
  try { if (r.shortcuts) shortcuts = validateShortcuts(r.shortcuts) } catch { /* damaged settings use safe defaults */ }
  return { recordingsRoot: root, cursorMode: mode, cursorSkin: skin, shortcuts }
}

export function loadSettings(): AppSettings {
  if (cache) return cache
  let raw: unknown = null
  try {
    raw = JSON.parse(fs.readFileSync(file(), 'utf8'))
  } catch {
    raw = null
  }
  cache = sanitizeSettings(raw, defaultRecordingsRoot())
  return cache
}

export function saveSettings(next: Partial<AppSettings>): AppSettings {
  const merged = sanitizeSettings({ ...loadSettings(), ...next }, defaultRecordingsRoot())
  cache = merged
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(merged, null, 2))
  } catch (err) {
    console.warn('[settings] could not save', err)
  }
  return merged
}

/** Current recordings root. Created on demand so a freshly chosen folder works immediately. */
export function getRecordingsRoot(): string {
  const root = loadSettings().recordingsRoot
  try {
    fs.mkdirSync(root, { recursive: true })
  } catch {
    // unwritable roots surface as errors when a recording starts
  }
  return root
}

export function setRecordingsRoot(root: string): AppSettings {
  const settings = saveSettings({ recordingsRoot: root })
  fs.mkdirSync(settings.recordingsRoot, { recursive: true })
  return settings
}

/** 'overlay' hides the real pointer and draws a sprite; 'system' keeps the real pointer. */
export function getCursorMode(): CursorMode {
  return loadSettings().cursorMode
}

/** The saved look every new recording starts with, or null for the app's defaults. */
export function getDefaultLook(): Look | null {
  return defaultLookIn(app.getPath('userData'))
}

export function getCursorSkin(): CursorSkin {
  return loadSettings().cursorSkin
}
