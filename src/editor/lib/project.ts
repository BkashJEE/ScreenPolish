// Immutable Project editing helpers and presets. Pure, tested.

import { BRAND_THEMES } from '../../brand'
import { normalizeScenes } from '../../shared/scenes'
import { DEFAULT_PROJECT, type Project } from '../../shared/types'
import { DEFAULT_ZOOM_SOUND, type ZoomSoundSettings } from '../../shared/zoom-sound'
import { CLICK_SOUND_STYLES, DEFAULT_CLICK_SOUND, type ClickSoundSettings } from '../../shared/click-sound'
import { normalizeCuts } from '../../shared/cuts'
import { normalizeCutTransition } from '../../shared/cut-transition'
import { normalizeCaptions } from '../../shared/captions'
import { normalizeCrop } from '../../shared/crop'

/** Replace fields inside one top-level group: patch(p, 'frame', { radius: 12 }). */
export function patchGroup<K extends keyof Project>(project: Project, key: K, patch: Partial<Project[K]>): Project {
  const current = project[key]
  if (typeof current !== 'object' || current === null) return { ...project, [key]: patch as Project[K] }
  const next = { ...(current as object), ...(patch as object) } as Project[K]
  // Skip the update entirely when nothing changed so autosave stays quiet.
  const currentRecord = current as Record<string, unknown>
  const nextRecord = next as Record<string, unknown>
  const keys = Object.keys(patch as object)
  if (keys.every((k) => Object.is(currentRecord[k], nextRecord[k]))) return project
  return { ...project, [key]: next }
}

/**
 * Fill any group missing from a project.json written by an older build with
 * the defaults, so the UI never reads an undefined knob.
 */
function normalizeAnimation(raw: Partial<Project['animation']> | null | undefined): Project['animation'] {
  const source = raw ?? {}
  const style = source.style === 'fade' || source.style === 'rise' || source.style === 'scale' ? source.style : DEFAULT_PROJECT.animation.style
  const finite = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return {
    style,
    durationSec: Math.min(2, Math.max(0, finite(source.durationSec, DEFAULT_PROJECT.animation.durationSec))),
    strength: Math.min(1, Math.max(0, finite(source.strength, DEFAULT_PROJECT.animation.strength)))
  }
}

export function normalizeClickSound(raw: Partial<ClickSoundSettings> | undefined): ClickSoundSettings {
  const style = CLICK_SOUND_STYLES.some((option) => option.value === raw?.style) ? raw!.style! : DEFAULT_CLICK_SOUND.style
  const volume = typeof raw?.volume === 'number' && Number.isFinite(raw.volume) ? Math.min(1, Math.max(0, raw.volume)) : DEFAULT_CLICK_SOUND.volume
  return { enabled: raw?.enabled === true, style, volume }
}

export function normalizeZoomSound(raw: Partial<ZoomSoundSettings> | undefined): ZoomSoundSettings {
  const volume = typeof raw?.volume === 'number' && Number.isFinite(raw.volume) ? Math.min(1, Math.max(0, raw.volume)) : DEFAULT_ZOOM_SOUND.volume
  const style = raw ? (raw.style === 'asmr' ? 'asmr' : 'classic') : DEFAULT_ZOOM_SOUND.style
  return { enabled: raw?.enabled === true, volume, style }
}

/**
 * The sprite pointer was called `hermes` while the only pack that shipped one
 * was that theme. Projects saved then keep working.
 */
export function migrateCursorStyle(style: unknown): Project['cursor']['style'] {
  if (style === 'hermes') return 'sprite'
  const known: Array<Project['cursor']['style']> = ['arrow', 'dot', 'hand', 'bobbing', 'sprite', 'agent', 'halo']
  return known.includes(style as Project['cursor']['style']) ? (style as Project['cursor']['style']) : DEFAULT_PROJECT.cursor.style
}

export function normalizeProject(raw: Partial<Project> | null | undefined): Project {
  const p = raw ?? {}
  return {
    version: 1,
    title: typeof p.title === 'string' ? p.title : '',
    trim: { ...DEFAULT_PROJECT.trim, ...(p.trim ?? {}) },
    speedRegions: Array.isArray(p.speedRegions) ? p.speedRegions.filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start && Number.isFinite(r.rate)).map((r) => ({ ...r, rate: Math.min(4, Math.max(0.25, r.rate)), ...(Number.isFinite(r.ease) && (r.ease as number) > 0 ? { ease: Math.min(r.ease as number, (r.end - r.start) / 2) } : {}) })) : [],
    cuts: normalizeCuts(p.cuts),
    splits: Array.isArray(p.splits) ? p.splits.filter((t) => Number.isFinite(t)) : [],
    cutTransition: normalizeCutTransition(p.cutTransition),
    captions: normalizeCaptions(p.captions),
    preserveAudioPitch: p.preserveAudioPitch !== false,
    crop: normalizeCrop(p.crop),
    audioRegions: Array.isArray(p.audioRegions) ? p.audioRegions.filter((r) => typeof r.path === 'string' && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start).map((r) => ({ ...r })) : [],
    output: { ...DEFAULT_PROJECT.output, ...(p.output ?? {}) },
    background: { ...DEFAULT_PROJECT.background, ...(p.background ?? {}) },
    frame: {
      ...DEFAULT_PROJECT.frame,
      ...(p.frame ?? {}),
      size: normalizeFrameSize(p.frame?.size),
      offsetX: finiteFraction(p.frame?.offsetX),
      offsetY: finiteFraction(p.frame?.offsetY)
    },
    mockup: { ...DEFAULT_PROJECT.mockup, ...(p.mockup ?? {}) },
    animation: normalizeAnimation(p.animation),
    cursor: { ...DEFAULT_PROJECT.cursor, ...(p.cursor ?? {}), style: migrateCursorStyle(p.cursor?.style), clickSound: normalizeClickSound(p.cursor?.clickSound ?? (typeof p.audio?.clickSounds === 'boolean' ? { enabled: p.audio.clickSounds } : undefined)) },
    zoom: {
      ...DEFAULT_PROJECT.zoom,
      ...(p.zoom ?? {}),
      perspective: p.zoom?.perspective === 'unified' ? 'unified' : 'legacy',
      manual: [...(p.zoom?.manual ?? [])],
      removedAuto: [...(p.zoom?.removedAuto ?? [])],
      sound: normalizeZoomSound(p.zoom?.sound)
    },
    webcam: { ...DEFAULT_PROJECT.webcam, ...(p.webcam ?? {}) },
    audio: { ...DEFAULT_PROJECT.audio, ...(p.audio ?? {}) },
    overlays: Array.isArray(p.overlays) ? p.overlays.map((o) => ({ ...o, text: o.text ? { ...o.text } : undefined, shape: o.shape ? { ...o.shape } : undefined })) : [],
    scenes: normalizeScenes(p.scenes)
  }
}

function normalizeFrameSize(value: unknown): number {
  const size = typeof value === 'number' && Number.isFinite(value) ? value : 1
  return Math.min(1.5, Math.max(0.5, size))
}

function finiteFraction(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(-0.5, Math.min(0.5, value)) : 0
}

export interface GradientPreset {
  name: string
  colors: [string, string]
  angle: number
}

export interface SolidPreset {
  name: string
  color: string
}

export const SOLID_PRESETS: SolidPreset[] = [
  { name: 'Slate', color: '#39445f' },
  { name: 'Midnight', color: '#18233b' },
  { name: 'Ink', color: '#151b24' },
  { name: 'Graphite', color: '#2b3038' },
  { name: 'Stone', color: '#575d68' },
  { name: 'Paper', color: '#e8eaed' },
  { name: 'Navy', color: '#203a5f' },
  { name: 'Plum', color: '#4d365f' },
  { name: 'Clay', color: '#765044' },
  { name: 'Forest', color: '#29483e' },
  // The recording is the subject; most of these sit back far enough to let it be.
  { name: 'Obsidian', color: '#0b0e14' },
  { name: 'Charcoal', color: '#1f2430' },
  { name: 'Pewter', color: '#3c4250' },
  { name: 'Denim', color: '#2f4a6d' },
  { name: 'Teal', color: '#1f4b4b' },
  { name: 'Olive', color: '#4a5340' },
  { name: 'Berry', color: '#5a2a4a' },
  { name: 'Rust', color: '#7a3f2b' },
  { name: 'Sand', color: '#d8cfc0' },
  { name: 'Linen', color: '#f2f0eb' }
]

export const GRADIENT_PRESETS: GradientPreset[] = [
  { name: 'Iris', colors: ['#5b6cff', '#c86dd7'], angle: 135 },
  { name: 'Sunset', colors: ['#ff7a59', '#ffc371'], angle: 135 },
  { name: 'Ocean', colors: ['#12c2e9', '#3a47d5'], angle: 160 },
  { name: 'Mint', colors: ['#43e97b', '#38f9d7'], angle: 120 },
  { name: 'Rose', colors: ['#f857a6', '#ff5858'], angle: 135 },
  { name: 'Ember', colors: ['#f12711', '#f5af19'], angle: 100 },
  { name: 'Slate', colors: ['#3a4152', '#1c1f27'], angle: 160 },
  { name: 'Graphite', colors: ['#2b2b2b', '#0d0d0d'], angle: 180 },
  { name: 'Snow', colors: ['#ffffff', '#dfe4ee'], angle: 160 },
  { name: 'Lilac', colors: ['#a18cd1', '#fbc2eb'], angle: 120 },
  // Deeper pairs, for when the take itself is bright and needs somewhere to sit.
  { name: 'Dusk', colors: ['#2b5876', '#4e4376'], angle: 150 },
  { name: 'Nightfall', colors: ['#141e30', '#243b55'], angle: 165 },
  { name: 'Indigo', colors: ['#0f2027', '#2c5364'], angle: 160 },
  { name: 'Carbon', colors: ['#232526', '#414345'], angle: 160 },
  { name: 'Steel', colors: ['#485563', '#29323c'], angle: 170 },
  { name: 'Cocoa', colors: ['#3e2723', '#6d4c41'], angle: 150 },
  { name: 'Aurora', colors: ['#1f4037', '#99f2c8'], angle: 140 },
  { name: 'Moss', colors: ['#134e5e', '#71b280'], angle: 140 },
  { name: 'Tide', colors: ['#2193b0', '#6dd5ed'], angle: 150 },
  { name: 'Violet', colors: ['#654ea3', '#eaafc8'], angle: 135 },
  { name: 'Copper', colors: ['#603813', '#b29f94'], angle: 135 },
  // Light ends, for dark UI captures.
  { name: 'Linen', colors: ['#f5f7fa', '#c3cfe2'], angle: 150 },
  { name: 'Peach', colors: ['#ffecd2', '#fcb69f'], angle: 120 },
  { name: 'Blush', colors: ['#ffdde1', '#ee9ca7'], angle: 130 }
]

/** Which preset (if any) matches the current colours and angle. */
export function matchPreset(bg: Project['background']): GradientPreset | null {
  if (bg.kind !== 'gradient') return null
  const [a, b] = bg.colors
  return (
    GRADIENT_PRESETS.find(
      (p) => p.colors[0].toLowerCase() === (a ?? '').toLowerCase() && p.colors[1].toLowerCase() === (b ?? '').toLowerCase() && p.angle === bg.angle
    ) ?? null
  )
}

export function matchSolidPreset(bg: Project['background']): SolidPreset | null {
  if (bg.kind !== 'solid') return null
  const color = bg.colors[0] ?? ''
  return SOLID_PRESETS.find((preset) => preset.color.toLowerCase() === color.toLowerCase()) ?? null
}

/** CSS background string for swatches and the background preview chip. */
export function backgroundCss(bg: Project['background']): string {
  const colors = bg.colors.length ? bg.colors : ['#000000']
  if (bg.kind === 'solid' || colors.length === 1) return colors[0]
  return `linear-gradient(${bg.angle}deg, ${colors.join(', ')})`
}

/**
 * Main serves user-picked background images on polish://image/<base64url(path)>
 * (see src/main/media-range.ts imageUrl) after allow-listing the path in
 * pickImage/save. Build the same URL here. Already-URLs pass through untouched.
 */
/** Backgrounds shipped with the app (resources/backgrounds), addressed as bundled:<relative path>. */
export interface BundledBackground {
  id: string
  name: string
  path: string
}

/**
 * Pack themes first, then the drawn set from scripts/backgrounds.py — meshes,
 * swirls and washes a two-colour gradient cannot reach, computed rather than
 * licensed so they are safe to redistribute — then the Omarchy theme every
 * build ships.
 */
export const BUNDLED_BACKGROUNDS: BundledBackground[] = [
  ...BRAND_THEMES.map((t) => ({ id: t.id, name: t.name, path: t.path })),
  // Vivid first: loud colour around the take, for posts that have to stop a scroll.
  { id: 'neon', name: 'Neon', path: 'bundled:backgrounds/neon.png' },
  { id: 'prism', name: 'Prism', path: 'bundled:backgrounds/prism.png' },
  { id: 'sunburst', name: 'Sunburst', path: 'bundled:backgrounds/sunburst.png' },
  { id: 'electric', name: 'Electric', path: 'bundled:backgrounds/electric.png' },
  { id: 'citrus', name: 'Citrus', path: 'bundled:backgrounds/citrus.png' },
  { id: 'holo', name: 'Holo', path: 'bundled:backgrounds/holo.png' },
  { id: 'candy', name: 'Candy', path: 'bundled:backgrounds/candy.png' },
  { id: 'aurora', name: 'Aurora', path: 'bundled:backgrounds/aurora.png' },
  { id: 'violet-haze', name: 'Violet Haze', path: 'bundled:backgrounds/violet-haze.png' },
  { id: 'dawn', name: 'Dawn', path: 'bundled:backgrounds/dawn.png' },
  { id: 'ember', name: 'Ember', path: 'bundled:backgrounds/ember.png' },
  { id: 'slate-mesh', name: 'Slate Mesh', path: 'bundled:backgrounds/slate-mesh.png' },
  { id: 'spotlight', name: 'Spotlight', path: 'bundled:backgrounds/spotlight.png' },
  { id: 'grid', name: 'Grid', path: 'bundled:backgrounds/grid.png' },
  { id: 'daylight', name: 'Daylight', path: 'bundled:backgrounds/daylight.png' },
  { id: 'omarchy', name: 'Omarchy', path: 'bundled:backgrounds/omarchy.png' }
]

export const BUNDLED_PREFIX = 'bundled:'

export function isBundledPath(path: string | undefined): boolean {
  return typeof path === 'string' && path.startsWith(BUNDLED_PREFIX)
}

export function imageUrlForPath(path: string): string {
  if (isBundledPath(path)) return `polish://asset/${path.slice(BUNDLED_PREFIX.length).replace(/^\/+/, '')}`
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return path
  return `polish://image/${base64url(path)}`
}

function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Shallow equality on the JSON form: cheap enough for a 1-KB project. */
export function projectEquals(a: Project, b: Project): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}
