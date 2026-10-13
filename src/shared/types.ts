import type { Scene } from './scenes'
import { DEFAULT_WEBCAM_LOOK, type WebcamLook } from './webcam-look'
import type { SpeedRegion } from './speed'
import type { Cut } from './cuts'
import type { CutTransition } from './cut-transition'
import type { CaptionSettings } from './captions'
import { DEFAULT_CLICK_SOUND, type ClickSoundSettings } from './click-sound'
import { DEFAULT_ZOOM_SOUND, type ZoomSoundSettings } from './zoom-sound'
// Shared data contracts. Everything the recorder writes and the editor reads is
// described here. See docs/superpowers/specs/2026-09-01-polish-design.md.

/** Captured area in physical pixels on the virtual desktop. */
export interface CaptureRegion {
  x: number
  y: number
  width: number
  height: number
  /** Display scale factor of the display the region sits on. */
  scale: number
}

export type MouseButton = 'left' | 'right' | 'middle'

/** events.json — the input log recorded alongside screen.mp4. */
export interface RecordingEvents {
  version: 1
  /** Unix ms. Video timestamp 0 corresponds to this instant. */
  startedAt: number
  region: CaptureRegion
  /** True when the OS cursor is part of the captured video (could not be hidden); the renderer then skips its own cursor. */
  cursorBaked?: boolean
  /** Authoritative stream metadata; absent for legacy/unreported portal captures. */
  cursorMode?: 'always' | 'motion' | 'never'
  /** [t ms from startedAt, x, y] with x,y region-relative physical px. */
  pointer: Array<[number, number, number]>
  clicks: Array<{ t: number; x: number; y: number; button: MouseButton; down: boolean }>
  wheel: Array<{ t: number; x: number; y: number; dy: number }>
  keys: Array<{ t: number; key: string; down: boolean }>
  /** Pauses: t is the video time (seconds) where recording resumed after a gap of durationSec wall-clock seconds. */
  pauses?: Array<{ t: number; durationSec: number }>
  /**
   * Why this take's input log is incomplete, in the words the recorder used at the time.
   * Present only when something was missing, so the editor can say why there are no clicks
   * instead of rendering an empty polish that looks like a bug.
   */
  inputNote?: string
}

/** How the camera moves during a segment. `zoom` is the plain push-in; tilts add fake perspective; drift is a slow dolly; punch snaps in. */
export type CameraStyle = 'zoom' | 'tilt-left' | 'tilt-right' | 'tilt-up' | 'tilt-down' | 'drift' | 'punch' | 'spring' | 'pan-left' | 'pan-right' | 'orbit'

export const CAMERA_STYLES: readonly CameraStyle[] = ['zoom', 'tilt-left', 'tilt-right', 'tilt-up', 'tilt-down', 'drift', 'punch', 'spring', 'pan-left', 'pan-right', 'orbit']

export interface ZoomSegment {
  id: string
  /** Seconds. */
  start: number
  end: number
  /** Focus point, region-relative physical px. */
  x: number
  y: number
  scale: number
  source: 'auto' | 'manual'
  /** Missing means 'zoom' (older project files). */
  style?: CameraStyle
}

export type OutputAspect = '16:9' | '9:16' | '1:1' | '4:5' | '4:3' | 'source'
export type OutputHeight = 720 | 1080 | 1440 | 2160
/** Pointer drawn into the video. Packs may add their own (see src/brand). */
export type CursorStyle = 'arrow' | 'dot' | 'hand' | 'bobbing' | 'sprite' | 'agent' | 'halo' | 'star'

export type WebcamCorner = 'br' | 'bl' | 'tr' | 'tl'

/** Where a background theme's lettering sits in the margin around the recording. */
export type LetteringPosition = 'top-left' | 'top' | 'bottom'
/** small ≈ half the bitrate and a smaller GIF, high ≈ 1.6x. */
export type ExportQuality = 'small' | 'balanced' | 'high'
export type MockupKind = 'none' | 'browser' | 'macos' | 'phone'
export type MockupTheme = 'dark' | 'light'

/** Non-empty source-space crop, with all values normalized to 0..1. */
export interface Crop {
  x: number
  y: number
  width: number
  height: number
}

/** A restrained entrance treatment applied to the complete presentation shell. */
export type AnimationStyle = 'none' | 'fade' | 'rise' | 'scale'

export interface AnimationSettings {
  style: AnimationStyle
  /** Seconds from the effective trim start. */
  durationSec: number
  /** 0..1; controls travel distance or scale amount, not opacity. */
  strength: number
}

/** Presentation frame drawn around the captured video in preview and export. */
export interface MockupSettings {
  kind: MockupKind
  theme: MockupTheme
  /** Shell/accent colour. */
  color: string
  /** Outer shell corner radius in output pixels. */
  radius: number
  /** Header/bezel depth as a fraction of the outer frame. */
  headerSize: number
}

export type OverlayKind = 'emoji' | 'text' | 'image' | 'arrow' | 'box' | 'blur'

/** Callout shapes drawn from settings rather than content. */
export const SHAPE_KINDS = ['arrow', 'box', 'blur'] as const
export type ShapeKind = (typeof SHAPE_KINDS)[number]

export interface OverlayShape {
  /** Arrow fill or box stroke colour. Unused by blur. */
  color: string
  /** Stroke weight, 1..10. */
  thickness: number
  /** Height of the shape's box as a fraction of its width. */
  aspect: number
  /** Box only: translucent fill inside the outline. */
  fill?: boolean
  /** Blur only: pixelate hides text more reliably than a soft blur. */
  mode?: 'pixelate' | 'blur'
  /** Blur only: strength, 1..10. */
  amount?: number
}

export interface OverlayText {
  font: string
  color: string
  outline: string
  /** Outline stroke as a percentage of the font size (0 = none). */
  outlineWidth: number
  weight: 400 | 600 | 800
  align: 'left' | 'center' | 'right'
  /** Rounded pill behind the text; omitted = none. */
  background?: string
}

/** A sticker, caption or picture composited over the output frame. */
export interface Overlay {
  id: string
  kind: OverlayKind
  /** emoji: the character(s); text: the string; image: absolute file path (served via polish://image/, see allowImage) */
  content: string
  /** centre, as fractions 0..1 of the OUTPUT frame */
  x: number
  y: number
  /** width as a fraction of the output width (height follows the aspect of the glyph/text/image) */
  w: number
  /** degrees */
  rotation: number
  /** seconds; end 0 = until the end of the recording */
  start: number
  end: number
  /** true = lives in video space (moves and scales with the camera zoom); false = screen space */
  pinned: boolean
  /** fade in/out duration, 0 = none */
  fadeSec: number
  text?: OverlayText
  /** Arrow, box and blur settings. */
  shape?: OverlayShape
}

/** project.json — editor state. Sources are never modified. */
export interface Project {
  version: 1
  /** Display name; auto-filled from the foreground window when the recording started. */
  title: string
  /** Seconds. end === 0 means "to the end of the recording". */
  trim: { start: number; end: number }
  speedRegions?: SpeedRegion[]
  /** Removed source ranges (clip slicer). Dropped from preview playback and export. */
  cuts?: Cut[]
  /** Source times the timeline was sliced at; boundaries between selectable clips. */
  splits?: number[]
  /** What covers the join a removed clip leaves. Absent means a hard cut. */
  cutTransition?: CutTransition
  /** Locally transcribed captions, burned into the output when enabled. */
  captions?: CaptionSettings
  preserveAudioPitch?: boolean
  audioRegions?: { id: string; path: string; start: number; end: number; offset: number; volume: number }[]
  /** Non-destructive source-space crop, normalized to the captured recording. */
  crop: Crop
  output: { aspect: OutputAspect; height: OutputHeight; fps: 30 | 60; quality: ExportQuality }
  background: { kind: 'gradient' | 'solid' | 'image'; colors: string[]; angle: number; imagePath?: string; blur?: number; /** Draw the theme's brand lettering; absent on projects saved before themes existed. */ lettering?: boolean; /** Where the lettering sits; absent means top left. */ letteringPosition?: LetteringPosition }
  /** padding as a fraction (0..0.3) of the shorter output side; size is a bounded card multiplier; radius in output px; shadow 0..1 */
  /** Whole-card translation as output fractions. Kept separate from camera focus. */
  frame: { padding: number; size: number; radius: number; shadow: number; offsetX: number; offsetY: number }
  mockup: MockupSettings
  animation: AnimationSettings
  /** size is a multiplier on a 32px base; smoothing 0..1 */
  cursor: { size: number; smoothing: number; /** 0..1, how much fast moves are slowed (see glidePointerPath); absent or 0 = off. */ glide?: number; /** Agent pointer fill, a hex colour; absent = the default violet. */ color?: string; /** 0..1, how far the recording dims away from the pointer; absent or 0 = off. */ spotlight?: number; ripple: boolean; style: CursorStyle; bounce?: boolean; sway?: number; motionBlur?: number; loop?: boolean; /** Fade the drawn pointer after this many idle seconds; absent or 0 keeps it always visible. */ idleHideSec?: number; /** Seconds the input log is moved later against the picture (see syncEvents); absent or 0 = as recorded. */ syncSec?: number; clickSound?: ClickSoundSettings }
  /** motion: 'zoom' keeps every automatic segment a plain zoom; 'cinematic' alternates zooms, tilts and drifts. */
  zoom: {
    enabled: boolean
    scale: number
    auto: boolean
    motion: 'zoom' | 'cinematic' | 'punch' | 'smart'
    /** Opt-in cohesive perspective; absent keeps older projects unchanged. */
    perspective?: 'legacy' | 'unified'
    /** Seconds to ease in and out of a segment. */
    easeSec: number
    /** 0..1, how much the camera drifts toward the pointer inside a segment. */
    follow: number
    /** Name of the template last applied, for the picker highlight. */
    template: string
    manual: ZoomSegment[]
    removedAuto: string[]
    /** Soft whoosh under each zoom in, zoom out and pan. */
    sound?: ZoomSoundSettings
  }
  webcam: { enabled: boolean; corner: WebcamCorner; size: number; round: boolean; reactive?: boolean; /** Absent in projects saved before the look existed. */ look?: WebcamLook }
  audio: { mic: boolean; system: boolean; micVolume: number; systemVolume: number; masterVolume: number; /** Legacy on/off from early window-tracking builds; migrated into cursor.clickSound. */ clickSounds?: boolean }
  overlays: Overlay[]
  /** Animated cards before and after the recording. See shared/scenes.ts. */
  scenes: Scene[]
}

export const DEFAULT_PROJECT: Project = {
  version: 1,
  title: '',
  trim: { start: 0, end: 0 },
  speedRegions: [],
  cuts: [],
  splits: [],
  cutTransition: { style: 'none', durationSec: 0.25 },
  captions: { enabled: false, cues: [], size: 1, position: 'bottom' },
  preserveAudioPitch: true,
  audioRegions: [],
  crop: { x: 0, y: 0, width: 1, height: 1 },
  output: { aspect: '16:9', height: 1080, fps: 30, quality: 'balanced' },
  background: { kind: 'solid', colors: ['#39445f'], angle: 0 },
  frame: { padding: 0.08, size: 1, radius: 16, shadow: 0.5, offsetX: 0, offsetY: 0 },
  mockup: { kind: 'none', theme: 'dark', color: '#111a1a', radius: 22, headerSize: 0.08 },
  animation: { style: 'none', durationSec: 0.45, strength: 0.35 },
  cursor: { size: 1.4, smoothing: 0.6, ripple: true, style: 'arrow', clickSound: { ...DEFAULT_CLICK_SOUND } },
  zoom: { enabled: true, scale: 2, auto: true, motion: 'cinematic', easeSec: 0.6, follow: 0.35, template: 'cinematic', manual: [], removedAuto: [], sound: { ...DEFAULT_ZOOM_SOUND } },
  webcam: { enabled: true, corner: 'br', size: 0.22, round: true, look: { ...DEFAULT_WEBCAM_LOOK } },
  audio: { mic: true, system: true, micVolume: 1, systemVolume: 1, masterVolume: 1 },
  overlays: [],
  scenes: []
}

/** Camera state for one output frame. cx,cy are region-relative physical px. */
export interface Camera {
  cx: number
  cy: number
  scale: number
  /** Degrees. Positive tiltX brings the left edge toward the viewer, positive tiltY the top edge. */
  tiltX?: number
  tiltY?: number
}

/** Files that may exist inside one recording folder. */
export interface RecordingFiles {
  folder: string
  screen: string
  mic?: string
  system?: string
  webcam?: string
  events: string
  project: string
}

export interface RecordingSummary {
  folder: string
  name: string
  createdAt: number
  durationSec: number | null
  thumbnail?: string
  title?: string
  /** Total bytes of the folder, exports included. */
  sizeBytes?: number
  /** polish:// URL of screen.mp4 for the library's hover preview; absent when the take is empty. */
  preview?: string
}
