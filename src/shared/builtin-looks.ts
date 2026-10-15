import { DEFAULT_CLICK_SOUND } from './click-sound'
import type { Look, LookPreset } from './presets'
import { DEFAULT_PROJECT } from './types'
import { DEFAULT_ZOOM_SOUND } from './zoom-sound'
import { ZOOM_TEMPLATES } from './zoom-templates'

/**
 * Looks that ship with the app, so a first video can look finished without
 * touching a setting. They sit above the saved ones in the Looks panel, can be
 * starred for every new recording like a saved look, and cannot be deleted.
 * Their ids start with BUILTIN_LOOK_PREFIX, which no saved look's id does.
 */
export const BUILTIN_LOOK_PREFIX = 'builtin:'

const zoomTemplate = (id: string) => ZOOM_TEMPLATES.find((t) => t.id === id)!.values

// Paths written out in full, so the bundled-assets check sees them.
const image = (imagePath: string, fallback: string): Look['background'] => ({ kind: 'image', colors: [fallback], angle: 0, imagePath, lettering: false })

/** What every built-in look starts from: the app's defaults for a new recording. */
function base(): Look {
  const { syncSec: _sync, ...cursor } = DEFAULT_PROJECT.cursor
  const { manual: _manual, removedAuto: _removed, ...zoom } = DEFAULT_PROJECT.zoom
  const { enabled: _enabled, ...webcam } = DEFAULT_PROJECT.webcam
  return {
    background: DEFAULT_PROJECT.background,
    frame: DEFAULT_PROJECT.frame,
    mockup: DEFAULT_PROJECT.mockup,
    animation: DEFAULT_PROJECT.animation,
    cursor: { ...cursor, glide: 0.5, clickSound: { ...DEFAULT_CLICK_SOUND, enabled: true } },
    zoom: { ...zoom, sound: { ...DEFAULT_ZOOM_SOUND, enabled: true } },
    captions: { size: 1, position: 'bottom' },
    webcam,
    output: DEFAULT_PROJECT.output
  }
}

function studio(): Look {
  const b = base()
  return {
    ...b,
    background: image('bundled:backgrounds/neon.png', '#1a0f2e'),
    frame: { ...b.frame, padding: 0.09, radius: 18, shadow: 0.75 },
    animation: { style: 'rise', durationSec: 0.6, strength: 0.35 },
    // Star draws its own click burst, so ripples stay off.
    cursor: { ...b.cursor, style: 'star', size: 1.5, ripple: false },
    zoom: { ...b.zoom, enabled: true, auto: true, ...zoomTemplate('glide'), template: 'glide', motionBlur: 0.5 },
    captions: { size: 1, position: 'bottom', style: 'karaoke' },
    webcam: { ...b.webcam, shadow: 0.8 },
    cutTransition: { style: 'dissolve', durationSec: 0.25 },
    output: { ...b.output, aspect: '16:9', height: 1080, quality: 'high' }
  }
}

function shorts(): Look {
  const b = base()
  return {
    ...b,
    background: image('bundled:backgrounds/sunburst.png', '#7a2a3a'),
    frame: { ...b.frame, padding: 0.05, radius: 22, shadow: 0.7 },
    animation: { style: 'scale', durationSec: 0.4, strength: 0.4 },
    cursor: { ...b.cursor, style: 'halo', size: 1.7, ripple: false },
    zoom: { ...b.zoom, enabled: true, auto: true, ...zoomTemplate('punchy'), template: 'punchy', motionBlur: 0.35 },
    captions: { size: 1, position: 'bottom', style: 'bold' },
    webcam: { ...b.webcam, corner: 'tr', size: 0.26 },
    cutTransition: { style: 'none', durationSec: 0.25 },
    output: { ...b.output, aspect: '9:16', height: 1080, quality: 'high' }
  }
}

function clean(): Look {
  const b = base()
  return {
    ...b,
    background: image('bundled:backgrounds/slate-mesh.png', '#1a1d24'),
    frame: { ...b.frame, padding: 0.07, radius: 14, shadow: 0.45 },
    animation: { style: 'fade', durationSec: 0.45, strength: 0.35 },
    cursor: { ...b.cursor, style: 'arrow', size: 1.3, ripple: true },
    zoom: { ...b.zoom, enabled: true, auto: true, ...zoomTemplate('subtle'), template: 'subtle', motionBlur: 0 },
    captions: { size: 0.9, position: 'bottom', style: 'minimal' },
    cutTransition: { style: 'dissolve', durationSec: 0.2 },
    output: { ...b.output, aspect: '16:9', height: 1080, quality: 'balanced' }
  }
}

export interface BuiltinLook extends LookPreset {
  /** One line under the name in the Looks panel. */
  blurb: string
}

export const BUILTIN_LOOKS: readonly BuiltinLook[] = [
  { id: `${BUILTIN_LOOK_PREFIX}studio`, name: 'Studio', blurb: 'Neon, Star pointer, Glide zooms with motion blur, word-by-word captions', look: studio() },
  { id: `${BUILTIN_LOOK_PREFIX}shorts`, name: 'Shorts', blurb: '9:16 for Reels and TikTok, Punchy zooms, big bold captions', look: shorts() },
  { id: `${BUILTIN_LOOK_PREFIX}clean`, name: 'Clean', blurb: 'Quiet slate, subtle zooms, plain captions, for docs and tutorials', look: clean() }
]

export function builtinLook(id: string | null | undefined): BuiltinLook | null {
  return (id && BUILTIN_LOOKS.find((l) => l.id === id)) || null
}
