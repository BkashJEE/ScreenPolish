import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { EMPTY_SHELF, defaultLook, deleteLook, normalizeShelf, saveLook, setDefaultLook, type Look, type LookShelf } from '@shared/presets'

/** Saved looks live beside settings.json, as looks.json in the app's settings folder. */
export const LOOKS_FILE = 'looks.json'

export function loadShelf(dir: string): LookShelf {
  try {
    return normalizeShelf(JSON.parse(fs.readFileSync(path.join(dir, LOOKS_FILE), 'utf8')))
  } catch {
    return { ...EMPTY_SHELF }
  }
}

function write(dir: string, shelf: LookShelf): LookShelf {
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, LOOKS_FILE)
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(shelf, null, 2))
  fs.renameSync(`${target}.tmp`, target)
  return shelf
}

export const saveLookIn = (dir: string, name: string, look: Look): LookShelf => write(dir, saveLook(loadShelf(dir), name, look, randomUUID))
export const deleteLookIn = (dir: string, id: string): LookShelf => write(dir, deleteLook(loadShelf(dir), id))
export const setDefaultLookIn = (dir: string, id: string | null): LookShelf => write(dir, setDefaultLook(loadShelf(dir), id))
/** The look new recordings start with, or null. A missing or broken file means none. */
export const defaultLookIn = (dir: string): Look | null => defaultLook(loadShelf(dir))
