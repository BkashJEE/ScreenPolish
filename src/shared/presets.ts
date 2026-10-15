import type { CaptionSettings } from './captions'
import type { Project } from './types'

/**
 * Looks: the style of a video, saved under a name and put on another take in
 * one click, or on every new recording.
 *
 * A look is how the video is dressed, never what is in it: the background,
 * frame, mockup, entrance, pointer, zoom style, caption style, webcam style,
 * cut transition and export shape. Trims, cuts, speed regions, zoom segments,
 * captions' words, overlays, title cards, music and click timing all belong to
 * one recording and are left alone.
 */
export interface Look {
  background: Project['background']
  frame: Project['frame']
  mockup: Project['mockup']
  animation: Project['animation']
  cursor: Omit<Project['cursor'], 'syncSec'>
  zoom: Omit<Project['zoom'], 'manual' | 'removedAuto'>
  captions: Pick<CaptionSettings, 'size' | 'position' | 'style' | 'highlight'>
  webcam: Omit<Project['webcam'], 'enabled'>
  cutTransition?: Project['cutTransition']
  output: Project['output']
}

export interface LookPreset {
  id: string
  name: string
  look: Look
}

export interface LookShelf {
  presets: LookPreset[]
  /** The look every new recording starts with; null for the app's defaults. */
  defaultId: string | null
}

export const EMPTY_SHELF: LookShelf = { presets: [], defaultId: null }
/** Enough to keep a style per channel or client without becoming a list to scroll. */
export const MAX_LOOKS = 24
export const MAX_LOOK_NAME = 40

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T))

/** The look of `project`. */
export function lookFromProject(project: Project): Look {
  const { syncSec: _sync, ...cursor } = project.cursor
  const { manual: _manual, removedAuto: _removed, ...zoom } = project.zoom
  const { enabled: _enabled, ...webcam } = project.webcam
  const captions = project.captions
  return clone({
    background: project.background,
    frame: project.frame,
    mockup: project.mockup,
    animation: project.animation,
    cursor,
    zoom,
    captions: {
      size: captions?.size ?? 1,
      position: captions?.position ?? 'bottom',
      ...(captions?.style ? { style: captions.style } : {}),
      ...(captions?.highlight ? { highlight: captions.highlight } : {})
    },
    webcam,
    ...(project.cutTransition ? { cutTransition: project.cutTransition } : {}),
    output: project.output
  })
}

/**
 * `project` dressed in `look`. Whatever belongs to the recording itself is
 * kept, including whether its webcam and captions are switched on.
 */
export function applyLook(project: Project, look: Look): Project {
  const l = clone(look)
  return {
    ...project,
    // Whole groups are replaced, not merged, so nothing from the old style lingers (an image path under a solid colour).
    background: l.background,
    frame: { ...project.frame, ...l.frame },
    mockup: { ...project.mockup, ...l.mockup },
    animation: { ...project.animation, ...l.animation },
    cursor: { ...l.cursor, ...(project.cursor.syncSec !== undefined ? { syncSec: project.cursor.syncSec } : {}) } as Project['cursor'],
    zoom: { ...project.zoom, ...l.zoom, manual: project.zoom.manual, removedAuto: project.zoom.removedAuto },
    ...(project.captions || l.captions.style || l.captions.highlight
      ? { captions: { enabled: project.captions?.enabled ?? false, cues: project.captions?.cues ?? [], ...l.captions } }
      : {}),
    webcam: { ...project.webcam, ...l.webcam, enabled: project.webcam.enabled },
    ...(l.cutTransition ? { cutTransition: l.cutTransition } : {}),
    output: { ...project.output, ...l.output }
  }
}

/** A shelf read from disk, with anything unusable dropped. */
export function normalizeShelf(raw: unknown): LookShelf {
  const r = (raw ?? {}) as Partial<LookShelf>
  const presets = Array.isArray(r.presets)
    ? r.presets
        .filter((p): p is LookPreset => !!p && typeof p.id === 'string' && !!p.id && typeof p.name === 'string' && !!p.name.trim() && !!p.look && typeof p.look === 'object' && !!p.look.background && !!p.look.cursor && !!p.look.output)
        .slice(0, MAX_LOOKS)
        .map((p) => ({ id: p.id, name: p.name.trim().slice(0, MAX_LOOK_NAME), look: p.look }))
    : []
  const defaultId = typeof r.defaultId === 'string' && presets.some((p) => p.id === r.defaultId) ? r.defaultId : null
  return { presets, defaultId }
}

/** The shelf with a look saved under `name`; saving an existing name replaces that look. */
export function saveLook(shelf: LookShelf, name: string, look: Look, newId: () => string): LookShelf {
  const clean = name.trim().slice(0, MAX_LOOK_NAME)
  if (!clean) throw new Error('A look needs a name.')
  const existing = shelf.presets.find((p) => p.name.toLowerCase() === clean.toLowerCase())
  if (existing) return { ...shelf, presets: shelf.presets.map((p) => (p.id === existing.id ? { ...p, name: clean, look } : p)) }
  if (shelf.presets.length >= MAX_LOOKS) throw new Error(`There is room for ${MAX_LOOKS} looks; delete one first.`)
  return { ...shelf, presets: [...shelf.presets, { id: newId(), name: clean, look }] }
}

export function deleteLook(shelf: LookShelf, id: string): LookShelf {
  return { presets: shelf.presets.filter((p) => p.id !== id), defaultId: shelf.defaultId === id ? null : shelf.defaultId }
}

export function setDefaultLook(shelf: LookShelf, id: string | null): LookShelf {
  return { ...shelf, defaultId: id && shelf.presets.some((p) => p.id === id) ? id : null }
}

/** The look new recordings start with, if one is chosen. */
export function defaultLook(shelf: LookShelf): Look | null {
  return shelf.presets.find((p) => p.id === shelf.defaultId)?.look ?? null
}
