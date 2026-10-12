import { drawTilted, hasTilt, projectCard, quadPath } from './tilt'
import { drawPerspective } from './perspective'
import { scratchCanvas } from './scratch-canvas'
import { cursorBobAt } from '../shared/cursor-bob'
import { handPressAt } from '../shared/hand-press'
// Frame renderer. One pure-ish function of (frame, events, project) -> pixels,
// shared by the editor preview and the exporter. Everything here draws on a
// plain 2D context so it works on a visible canvas and on an OffscreenCanvas.
// See docs/superpowers/specs/2026-09-01-polish-design.md, "Render".

import type { Camera, Crop, LetteringPosition, Overlay, Project, RecordingEvents, ZoomSegment } from '../shared/types'
import { normalizeCrop } from '../shared/crop'
import { cameraAt } from '../shared/camera'
import { effectiveTrim, webcamRect, type Rect } from '../shared/layout'
import { DEFAULT_WEBCAM_LOOK } from '../shared/webcam-look'
import { drawWebcamLook } from './webcam-look'
import { cameraPointerAt, ripplesAt, smoothedPointerAt } from '../shared/pointer'
import { cursorAlphaAt } from '../shared/cursor-idle'
import { drawMockupChrome, mockupGeometry, type MockupGeometry } from './mockup'
import { drawOverlays, type OverlayDrawArgs, type PinMapping } from './overlays'
import { drawKnight } from '../brand'
import { BRAND_THEMES, drawBrandLettering, knightPoseAt, type KnightPose } from '../brand'
import { drawCaptions } from './captions'

export interface FrameInput {
  /** Current source frame (HTMLVideoElement, VideoFrame, canvas). */
  video: CanvasImageSource
  /** Source pixel size (= events.region width/height in physical px). */
  videoSize: { width: number; height: number }
  /** Recording time in seconds. */
  tSec: number
  events: RecordingEvents
  project: Project
  /** Already resolved (auto + manual, removedAuto applied). */
  segments: ZoomSegment[]
  /** From smoothPointerPath, may be empty. */
  pointerPath: Array<[number, number, number]>
  webcam?: CanvasImageSource | null
  /** Decoded project.background.imagePath, if any. */
  backgroundImage?: CanvasImageSource | null
  /** Overlays to composite; defaults to project.overlays. */
  overlays?: Overlay[]
  /** Decoded image overlays keyed by overlay.content (path). Missing images are skipped. */
  overlayImages?: Map<string, CanvasImageSource>
  /** Draw every overlay regardless of its time range (thumbnail maker). */
  overlaysIgnoreTime?: boolean
  /** Recording length; resolves overlay end === 0 so fades out can happen at the end. */
  duration?: number
}

export type { Ctx2D } from '../shared/ctx2d'
import type { Ctx2D } from '../shared/ctx2d'

/** Base cursor sprite height in output px at cursor.size 1 and camera scale 1. */
export const CURSOR_BASE_PX = 32
/** How long a click ripple lives, seconds. Must match what ripplesAt is asked for. */
export const RIPPLE_LIFE_SEC = 0.5
/** Ripple ring radius range in output px at mapping scale 1. */
export const RIPPLE_MIN_RADIUS = 8
export const RIPPLE_MAX_RADIUS = 40

export interface VideoMapping {
  /** Output px per source px. */
  scale: number
  /** Output x of source x = 0. */
  tx: number
  /** Output y of source y = 0. */
  ty: number
}

export interface SourceCropRect {
  x: number
  y: number
  width: number
  height: number
}

/** Convert normalized ORIGINAL-source crop coordinates to source pixels. */
export function cropToSourceRect(crop: Crop | unknown, source: { width: number; height: number }): SourceCropRect {
  const c = normalizeCrop(crop)
  return { x: c.x * source.width, y: c.y * source.height, width: c.width * source.width, height: c.height * source.height }
}

/** Map an original-source point into cropped-source local pixel space. */
export function sourceToCroppedPoint(point: { x: number; y: number }, cropRect: SourceCropRect): { x: number; y: number } {
  return { x: point.x - cropRect.x, y: point.y - cropRect.y }
}

// ---------------------------------------------------------------------------

/**
 * Affine mapping from source-video pixels to output pixels: outputX = tx + scale * srcX.
 * Camera scale 1 fills `rect` exactly; camera scale s scales the video s× about the
 * focus so (camera.cx, camera.cy) lands at the rect centre. The mapping never shows
 * outside the video: the translation is clamped so the video always covers the rect
 * (the camera is pre-clamped upstream, but we clamp again defensively).
 */
export function videoToOutput(
  camera: Camera,
  videoSize: { width: number; height: number },
  rect: Rect
): VideoMapping {
  const vw = Math.max(videoSize.width, 1e-6)
  const vh = Math.max(videoSize.height, 1e-6)
  // Uniform base scale that fits the video in the rect (equal on both axes when the
  // rect preserves the source aspect, which contentRect does).
  const base = Math.min(rect.width / vw, rect.height / vh)
  const camScale = Number.isFinite(camera.scale) && camera.scale > 0 ? camera.scale : 1
  const scale = base * camScale

  const drawnW = scale * vw
  const drawnH = scale * vh
  const centerX = rect.x + rect.width / 2
  const centerY = rect.y + rect.height / 2

  const tx = clampTranslation(centerX - scale * camera.cx, rect.x, rect.width, drawnW)
  const ty = clampTranslation(centerY - scale * camera.cy, rect.y, rect.height, drawnH)
  return { scale, tx, ty }
}

/**
 * Keep a drawn span of `drawn` px covering the rect span [rectStart, rectStart+rectLen].
 * If the drawn span is smaller than the rect (camera scale < 1) it is centred instead.
 */
function clampTranslation(t: number, rectStart: number, rectLen: number, drawn: number): number {
  if (drawn <= rectLen) return rectStart + (rectLen - drawn) / 2
  const min = rectStart + rectLen - drawn
  const max = rectStart
  return Math.min(max, Math.max(min, t))
}

/** Natural pixel size of any CanvasImageSource. */
export function imageSourceSize(src: CanvasImageSource): { width: number; height: number } {
  const s = src as unknown as Record<string, unknown>
  const num = (k: string): number | null => (typeof s[k] === 'number' ? (s[k] as number) : null)
  const pairs: Array<[string, string]> = [
    ['videoWidth', 'videoHeight'], // HTMLVideoElement
    ['naturalWidth', 'naturalHeight'], // HTMLImageElement
    ['displayWidth', 'displayHeight'], // VideoFrame
    ['codedWidth', 'codedHeight'], // VideoFrame fallback
    ['width', 'height'] // canvas, ImageBitmap, OffscreenCanvas
  ]
  for (const [wk, hk] of pairs) {
    const w = num(wk)
    const h = num(hk)
    if (w !== null && h !== null && w > 0 && h > 0) return { width: w, height: h }
  }
  return { width: 0, height: 0 }
}

/** Destination rect that covers `box` with an image of `img` size, preserving aspect. */
function coverRect(img: { width: number; height: number }, box: Rect): Rect {
  if (img.width <= 0 || img.height <= 0) return box
  const s = Math.max(box.width / img.width, box.height / img.height)
  const w = img.width * s
  const h = img.height * s
  return { x: box.x + (box.width - w) / 2, y: box.y + (box.height - h) / 2, width: w, height: h }
}

function roundedRectPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2))
  ctx.beginPath()
  if (r === 0) {
    ctx.rect(x, y, w, h)
    return
  }
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/**
 * Pinned overlays are authored in screen space at camera scale 1. This maps
 * such a position (output fractions) through the current camera: screen px at
 * scale 1 -> source px -> screen px now, with the zoom factor for sizing.
 */
export function pinMapping(base: VideoMapping, mapping: VideoMapping, output: { width: number; height: number }): PinMapping {
  return (fx, fy) => {
    const vx = (fx * output.width - base.tx) / base.scale
    const vy = (fy * output.height - base.ty) / base.scale
    return { x: mapping.tx + mapping.scale * vx, y: mapping.ty + mapping.scale * vy, scale: mapping.scale / base.scale }
  }
}

export interface FrameGeometry {
  rect: Rect
  /** Outer presentation shell; equals rect when mockups are disabled. */
  outer: Rect
  camera: Camera
  /** Current camera mapping. */
  mapping: VideoMapping
  /** Mapping at camera scale 1 (what pinned overlays are authored against). */
  base: VideoMapping
  pointer: { x: number; y: number } | null
  /** Crop in original source pixels; mappings use this crop's local space. */
  crop: SourceCropRect
}

export function frameOffset(project: Project, output: { width: number; height: number }): { x: number; y: number } {
  const x = Number.isFinite(project.frame.offsetX) ? project.frame.offsetX : 0
  const y = Number.isFinite(project.frame.offsetY) ? project.frame.offsetY : 0
  return { x: x * output.width, y: y * output.height }
}

/** Screen-card scale, intentionally bounded so it cannot become invalid geometry. */
export function frameSize(project: Project): number {
  const size = Number.isFinite(project.frame.size) ? project.frame.size : 1
  return Math.min(1.5, Math.max(0.5, size))
}

function scaleRectAround(rect: Rect, pivot: { x: number; y: number }, size: number): Rect {
  return {
    x: pivot.x + (rect.x - pivot.x) * size,
    y: pivot.y + (rect.y - pivot.y) * size,
    width: rect.width * size,
    height: rect.height * size
  }
}

function scaleMockupGeometry(g: MockupGeometry, size: number): MockupGeometry {
  const pivot = { x: g.outer.x + g.outer.width / 2, y: g.outer.y + g.outer.height / 2 }
  return {
    ...g,
    outer: scaleRectAround(g.outer, pivot, size),
    content: scaleRectAround(g.content, pivot, size),
    headerPx: g.headerPx * size,
    borderPx: g.borderPx * size
  }
}

function shiftMockupGeometry(g: MockupGeometry, offset: { x: number; y: number }): MockupGeometry {
  const shift = (r: Rect): Rect => ({ ...r, x: r.x + offset.x, y: r.y + offset.y })
  return { ...g, outer: shift(g.outer), content: shift(g.content) }
}

type CroppedCameraInputs = { key: string; segments: ZoomSegment[]; pointer: (tSec: number) => { x: number; y: number } | null }
const croppedInputsCache = new WeakMap<ZoomSegment[], WeakMap<object, CroppedCameraInputs>>()

/**
 * Segments and a camera pointer in cropped-source coordinates, reused across
 * frames. The camera path is precomputed per segment list and pointer
 * function, so handing it fresh copies every frame would rebuild it each time.
 */
function croppedCameraInputs(segments: ZoomSegment[], pointerPath: FrameInput['pointerPath'], crop: Rect): CroppedCameraInputs {
  const key = `${crop.x},${crop.y},${crop.width},${crop.height}`
  let byPath = croppedInputsCache.get(segments)
  if (!byPath) {
    byPath = new WeakMap()
    croppedInputsCache.set(segments, byPath)
  }
  const hit = byPath.get(pointerPath)
  if (hit && hit.key === key) return hit
  const inputs: CroppedCameraInputs = {
    key,
    segments: segments.map((segment) => ({ ...segment, ...sourceToCroppedPoint({ x: segment.x, y: segment.y }, crop) })),
    pointer: (tSec) => {
      const p = cameraPointerAt(pointerPath, tSec)
      return p ? sourceToCroppedPoint(p, crop) : null
    }
  }
  byPath.set(pointerPath, inputs)
  return inputs
}

/** Content rect, camera and mappings for one frame; shared by renderFrame and the preview's hit testing. */
export function frameGeometry(
  input: Pick<FrameInput, 'videoSize' | 'project' | 'tSec' | 'segments' | 'pointerPath'>,
  output: { width: number; height: number }
): FrameGeometry {
  const { videoSize, project } = input
  const crop = cropToSourceRect(project.crop, videoSize)
  const croppedSize = { width: crop.width, height: crop.height }
  const mockup = scaleMockupGeometry(shiftMockupGeometry(mockupGeometry(output, croppedSize, project.frame.padding, project.mockup), frameOffset(project, output)), frameSize(project))
  const rect = mockup.content
  const pointer = smoothedPointerAt(input.pointerPath, input.tSec)
  const { segments: localSegments, pointer: localPointer } = croppedCameraInputs(input.segments, input.pointerPath, crop)
  const camera = cameraAt(input.tSec, localSegments, localPointer, croppedSize, { easeSec: project.zoom.easeSec ?? 0.6, follow: project.zoom.follow ?? 0.35 })
  const mapping = videoToOutput(camera, croppedSize, rect)
  const base = videoToOutput({ cx: croppedSize.width / 2, cy: croppedSize.height / 2, scale: 1 }, croppedSize, rect)
  return { rect, outer: mockup.outer, camera, mapping, base, pointer, crop }
}

/** Everything overlay layout needs from a FrameInput (no video required). */
export type OverlayLayoutInput = Pick<FrameInput, 'videoSize' | 'project' | 'tSec' | 'segments' | 'pointerPath' | 'overlayImages' | 'overlaysIgnoreTime' | 'duration'>

/** The OverlayDrawArgs renderFrame uses for `input`, so the preview can lay overlays out identically. */
export function overlayArgsFor(input: OverlayLayoutInput, output: { width: number; height: number }, geometry?: FrameGeometry): OverlayDrawArgs {
  const g = geometry ?? frameGeometry(input, output)
  return {
    tSec: input.tSec,
    output,
    toOutput: pinMapping(g.base, g.mapping, output),
    images: input.overlayImages ?? EMPTY_IMAGES,
    skipTime: input.overlaysIgnoreTime,
    duration: input.duration,
    which: 'all'
  }
}

const EMPTY_IMAGES = new Map<string, CanvasImageSource>()

// ---------------------------------------------------------------------------
// Background

export function drawBackground(
  ctx: Ctx2D,
  size: { width: number; height: number },
  background: Project['background'],
  image?: CanvasImageSource | null
): void {
  const { width, height } = size
  const colors = background.colors.length > 0 ? background.colors : ['#000000']

  if (background.kind === 'image' && image) {
    const imgSize = imageSourceSize(image)
    if (imgSize.width > 0 && imgSize.height > 0) {
      // Solid base so a transparent image still has a defined ground.
      ctx.fillStyle = colors[0]
      ctx.fillRect(0, 0, width, height)
      const dest = coverRect(imgSize, { x: 0, y: 0, width, height })
      ctx.drawImage(image, dest.x, dest.y, dest.width, dest.height)
      return
    }
    // Image not usable: fall through to the gradient/solid below.
  }

  if (background.kind === 'solid' || colors.length === 1) {
    ctx.fillStyle = colors[0]
    ctx.fillRect(0, 0, width, height)
    return
  }

  // CSS-style angle: 0deg points up, 90deg points right, clockwise.
  const rad = ((background.angle ?? 0) * Math.PI) / 180
  const dx = Math.sin(rad)
  const dy = -Math.cos(rad)
  const half = (Math.abs(width * dx) + Math.abs(height * dy)) / 2
  const cx = width / 2
  const cy = height / 2
  const grad = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half)
  const last = colors.length - 1
  colors.forEach((c, i) => grad.addColorStop(last === 0 ? 0 : i / last, c))
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, width, height)
}

/** Local brand fonts, loaded before preview/export starts. Keep branding in the
 * outer background margin; never cover the recorded screen or follow its zoom. */
/**
 * The bundled theme image whose name should be drawn, or undefined. Only while
 * the background is that image: switching to a gradient or solid keeps the
 * image path and the lettering flag in the project, and the theme's name must
 * not follow onto a background it does not belong to.
 */
export function brandImagePath(background: { kind: string; imagePath?: string }): string | undefined {
  return background.kind === 'image' ? background.imagePath : undefined
}

/** Gap between the lettering and the output edge, as fractions of the shorter side. */
const BRAND_MARGIN_X = 0.028
const BRAND_MARGIN_Y = 0.018

/** Top-left corner for lettering of the given size at the chosen position. */
export function brandOrigin(
  size: { width: number; height: number },
  box: { width: number; height: number },
  position: LetteringPosition = 'top-left'
): { x: number; y: number } {
  const unit = Math.min(size.width, size.height)
  const marginY = unit * BRAND_MARGIN_Y
  if (position === 'top-left') return { x: unit * BRAND_MARGIN_X, y: marginY }
  const x = (size.width - box.width) / 2
  return { x, y: position === 'top' ? marginY : size.height - marginY - box.height }
}

export function drawBackgroundBrand(
  ctx: Ctx2D,
  size: { width: number; height: number },
  path?: string,
  lettering = false,
  position: LetteringPosition = 'top-left'
): void {
  // Opt-in per project: a recording saved before themes existed keeps the
  // background it had, without lettering appearing on a re-export.
  if (!lettering) return
  // Which lettering belongs to this background: a pack theme brings its own,
  // and the Omarchy theme every build ships draws its wordmark glyph.
  const packTheme = BRAND_THEMES.find((t) => t.path === path)
  const omarchy = path === 'bundled:backgrounds/omarchy.png'
  if (!packTheme && !omarchy) return
  const unit = Math.min(size.width, size.height)
  ctx.save()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  if (packTheme) drawBrandLettering(ctx, size, unit, (box) => brandOrigin(size, box, position))
  else {
    const fontSize = unit * 0.035
    const maxWidth = size.width * 0.42
    ctx.fillStyle = '#7aa2f7'
    ctx.font = `${fontSize}px "Omarchy Brand"`
    const width = Math.min(ctx.measureText('\ue900').width, maxWidth)
    const { x, y } = brandOrigin(size, { width, height: fontSize }, position)
    ctx.fillText('\ue900', x, y, maxWidth)
  }
  ctx.restore()
}

// ---------------------------------------------------------------------------
// Cursor

/** Classic arrow outline in a unit box (height 1). Hotspot is (0, 0) at the tip. */
const ARROW_POINTS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0, 0.83],
  [0.22, 0.65],
  [0.38, 1.0],
  [0.53, 0.93],
  [0.37, 0.59],
  [0.66, 0.59]
]

let arrowPath2D: Path2D | null | undefined

/** Unit arrow as a Path2D when the platform has one (browser); null in plain node. */
function unitArrowPath(): Path2D | null {
  if (arrowPath2D !== undefined) return arrowPath2D
  if (typeof Path2D === 'undefined') {
    arrowPath2D = null
    return null
  }
  const p = new Path2D()
  traceArrow(p)
  arrowPath2D = p
  return p
}

function traceArrow(target: { moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; closePath(): void }): void {
  ARROW_POINTS.forEach(([x, y], i) => (i === 0 ? target.moveTo(x, y) : target.lineTo(x, y)))
  target.closePath()
}

/** The Agent pointer's fill when the project names none. */
export const AGENT_POINTER_COLOR = '#7f77dd'

/**
 * The Agent pointer: a rounded arrow in a colour, inside a white outline that
 * keeps it readable on dark and light screens alike. Unit coordinates, tip at
 * the origin (the hotspot), about 0.95 tall.
 */
function traceAgentArrow(ctx: Ctx2D): void {
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(0, 0.8)
  ctx.lineTo(0.21, 0.61)
  ctx.lineTo(0.35, 0.91)
  ctx.lineTo(0.48, 0.86)
  ctx.lineTo(0.35, 0.57)
  ctx.lineTo(0.62, 0.55)
  ctx.closePath()
}

/** How far behind the dot the Halo's ring runs, in seconds of pointer path. */
export const HALO_RING_LAG_SEC = 0.09
/** The ring never strays further than this many pointer sizes from the dot. */
export const HALO_MAX_OFFSET = 1.4

/**
 * How tightly the Halo's ring is pressed, 0 to 1, `ageSec` after a click: it
 * closes quickly on the press and opens again over a third of a second.
 */
export function haloPressAt(ageSec: number): number {
  if (!(ageSec >= 0) || ageSec >= 0.38) return 0
  if (ageSec < 0.08) return ageSec / 0.08
  const t = (ageSec - 0.08) / 0.3
  return 1 - t * t * (3 - 2 * t)
}

/** The ring's offset from the dot, shortened to HALO_MAX_OFFSET so a fast flick never leaves it far behind. */
export function haloRingOffset(dx: number, dy: number, sizePx: number): { dx: number; dy: number } {
  const max = HALO_MAX_OFFSET * sizePx
  const d = Math.hypot(dx, dy)
  if (!(d > max)) return { dx, dy }
  return { dx: (dx / d) * max, dy: (dy / d) * max }
}

/**
 * The Halo pointer: a small dot on the hotspot and a thin ring that floats a
 * moment behind it, tightening on a click. The ring has a faint dark edge so
 * it holds on white pages; the dot takes the pointer colour, white by default.
 */
export function drawHalo(ctx: Ctx2D, x: number, y: number, ringX: number, ringY: number, sizePx: number, press: number, color?: string): void {
  if (!(sizePx > 0)) return
  const k = Math.min(1, Math.max(0, press || 0))
  const ring = sizePx * 0.62 * (1 - 0.3 * k)
  const line = Math.max(1, sizePx * 0.07)
  ctx.save()
  ctx.beginPath()
  ctx.arc(ringX, ringY, ring, 0, Math.PI * 2)
  ctx.fillStyle = `rgba(255, 255, 255, ${(0.06 + 0.14 * k).toFixed(3)})`
  ctx.fill()
  ctx.lineWidth = line * 2.2
  ctx.strokeStyle = 'rgba(14, 20, 28, 0.32)'
  ctx.stroke()
  ctx.lineWidth = line
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)'
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(x, y, sizePx * 0.17, 0, Math.PI * 2)
  ctx.fillStyle = color && /^#[0-9a-f]{6}$/i.test(color) ? color : '#ffffff'
  ctx.fill()
  ctx.lineWidth = Math.max(1, sizePx * 0.05)
  ctx.strokeStyle = 'rgba(14, 20, 28, 0.55)'
  ctx.stroke()
  ctx.restore()
}

/** The Star pointer's gold when the project names no colour. */
export const STAR_POINTER_COLOR = '#f5c542'
/** How much pointer path the Star's comet tail covers, in seconds, and in how many samples. */
export const STAR_TRAIL_SEC = 0.32
export const STAR_TRAIL_SAMPLES = 12
/** How long a click's sparkle burst lasts. */
export const STAR_BURST_SEC = 0.55

function starColor(color?: string): string {
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color : STAR_POINTER_COLOR
}

/** `hex` moved toward white (amount > 0) or black (amount < 0), as an rgba() string. */
function shadeHex(hex: string, amount: number, alpha = 1): string {
  const n = parseInt(hex.slice(1), 16)
  const toward = amount >= 0 ? 255 : 0
  const k = Math.abs(amount)
  const ch = (v: number) => Math.round(v + (toward - v) * k)
  return `rgba(${ch((n >> 16) & 255)}, ${ch((n >> 8) & 255)}, ${ch(n & 255)}, ${alpha})`
}

/** A four-pointed sparkle with curved, inward sides: ✦, tips at radius `r`. */
function traceSparkle(ctx: Ctx2D, x: number, y: number, r: number, rotation = 0): void {
  const tip = (k: number) => {
    const a = rotation - Math.PI / 2 + (k * Math.PI) / 2
    return [x + Math.cos(a) * r, y + Math.sin(a) * r] as const
  }
  ctx.beginPath()
  const [sx, sy] = tip(0)
  ctx.moveTo(sx, sy)
  for (let k = 0; k < 4; k++) {
    const a = rotation - Math.PI / 2 + (k * Math.PI) / 2 + Math.PI / 4
    const [nx, ny] = tip(k + 1)
    ctx.quadraticCurveTo(x + Math.cos(a) * r * 0.16, y + Math.sin(a) * r * 0.16, nx, ny)
  }
  ctx.closePath()
}

/**
 * The Star pointer: a gold sparkle on the hotspot in a soft glow, twinkling
 * slowly with time `tSec` and swelling by `pop` (0 to 1) on a click. A thin
 * amber edge keeps it visible on white pages.
 */
export function drawStar(ctx: Ctx2D, x: number, y: number, sizePx: number, color?: string, tSec = 0, pop = 0): void {
  if (!(sizePx > 0)) return
  const base = starColor(color)
  const r = sizePx * 0.5 * (1 + 0.06 * Math.sin(tSec * 3.1) + 0.28 * Math.min(1, Math.max(0, pop || 0)))
  const rotation = 0.12 * Math.sin(tSec * 1.7)
  ctx.save()
  const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 1.7)
  glow.addColorStop(0, shadeHex(base, 0.35, 0.5))
  glow.addColorStop(1, shadeHex(base, 0, 0))
  ctx.fillStyle = glow
  ctx.beginPath()
  ctx.arc(x, y, r * 1.7, 0, Math.PI * 2)
  ctx.fill()
  traceSparkle(ctx, x, y, r, rotation)
  const body = ctx.createRadialGradient(x, y, 0, x, y, r)
  body.addColorStop(0, shadeHex(base, 0.85))
  body.addColorStop(0.35, shadeHex(base, 0.25))
  body.addColorStop(1, shadeHex(base, -0.2))
  ctx.fillStyle = body
  ctx.fill()
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(1, sizePx * 0.045)
  ctx.strokeStyle = shadeHex(base, -0.6, 0.6)
  ctx.stroke()
  ctx.restore()
}

/** The Star's tail never runs longer than this many pointer sizes, however fast the move. */
export const STAR_TRAIL_MAX = 4

/**
 * The Star's comet tail along `points`, newest first (the first point is the
 * star itself), cut off at STAR_TRAIL_MAX pointer sizes so a jump across the
 * screen still reads as a short streak. It tapers and fades with distance from
 * the star, with sparkles shimmering along it; a pointer at rest has no tail.
 */
export function drawStarTrail(ctx: Ctx2D, points: Array<{ x: number; y: number }>, sizePx: number, color?: string, tSec = 0): void {
  if (!(sizePx > 0) || points.length < 2) return
  const base = starColor(color)
  const maxLen = STAR_TRAIL_MAX * sizePx
  const path: Array<{ x: number; y: number; at: number }> = [{ ...points[0]!, at: 0 }]
  let total = 0
  for (let i = 1; i < points.length; i++) {
    const a = path[path.length - 1]!
    const b = points[i]!
    const seg = Math.hypot(b.x - a.x, b.y - a.y)
    if (seg < 0.5) continue
    if (total + seg >= maxLen) {
      const k = (maxLen - total) / seg
      path.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, at: maxLen })
      total = maxLen
      break
    }
    total += seg
    path.push({ x: b.x, y: b.y, at: total })
  }
  if (total < 1) return
  ctx.save()
  ctx.lineCap = 'round'
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!
    const b = path[i]!
    const fade = 1 - (a.at + b.at) / 2 / maxLen
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.lineWidth = Math.max(0.5, sizePx * 0.22 * fade)
    ctx.strokeStyle = shadeHex(base, 0.45, 0.75 * fade)
    ctx.stroke()
  }
  // Sparkles at set distances behind the star, so they ride along the tail
  // instead of crawling up it as the samples move.
  const spots = [0.55, 1.05, 1.6, 2.2, 2.85, 3.5]
  spots.forEach((d, i) => {
    const at = d * sizePx
    if (at > total) return
    const j = path.findIndex((p) => p.at >= at)
    const a = path[j - 1]!
    const b = path[j]!
    const k = (at - a.at) / Math.max(1e-6, b.at - a.at)
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const side = sizePx * 0.2 * Math.sin(tSec * 9 + i * 1.7)
    const sx = a.x + (b.x - a.x) * k + (-(b.y - a.y) / len) * side
    const sy = a.y + (b.y - a.y) * k + ((b.x - a.x) / len) * side
    const fade = 1 - at / maxLen
    traceSparkle(ctx, sx, sy, sizePx * 0.22 * (0.5 + 0.5 * fade), tSec * 2 + i)
    ctx.fillStyle = shadeHex(base, 0.6, 0.95 * fade)
    ctx.fill()
  })
  ctx.restore()
}

/** Small sparkles flying out from a click at (`x`, `y`), `ageSec` after it; `seed` turns each burst differently. */
export function drawStarBurst(ctx: Ctx2D, x: number, y: number, sizePx: number, ageSec: number, seed: number, color?: string): void {
  if (!(sizePx > 0) || !(ageSec >= 0) || ageSec >= STAR_BURST_SEC) return
  const base = starColor(color)
  const p = ageSec / STAR_BURST_SEC
  const out = 1 - (1 - p) * (1 - p)
  ctx.save()
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3 + seed * 0.7
    const d = sizePx * (0.45 + 1.5 * out) * (i % 2 ? 0.8 : 1)
    traceSparkle(ctx, x + Math.cos(a) * d, y + Math.sin(a) * d, sizePx * 0.17 * (1 - p), a)
    ctx.fillStyle = shadeHex(base, 0.45, 1 - p)
    ctx.fill()
  }
  ctx.restore()
}

export function drawCursor(ctx: Ctx2D, x: number, y: number, sizePx: number, style: Project['cursor']['style'], color?: string): void {
  if (!(sizePx > 0)) return
  ctx.save()
  ctx.translate(x, y)

  if (style === 'agent') {
    ctx.scale(sizePx, sizePx)
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    // A thin dark edge outside the white one, so the outline holds on white pages.
    traceAgentArrow(ctx)
    ctx.lineWidth = 0.16
    ctx.strokeStyle = 'rgba(14, 20, 28, 0.55)'
    ctx.stroke()
    traceAgentArrow(ctx)
    ctx.lineWidth = 0.11
    ctx.strokeStyle = '#ffffff'
    ctx.stroke()
    ctx.fillStyle = color && /^#[0-9a-f]{6}$/i.test(color) ? color : AGENT_POINTER_COLOR
    ctx.fill()
    ctx.restore()
    return
  }

  if (style === 'star') {
    drawStar(ctx, 0, 0, sizePx, color)
    ctx.restore()
    return
  }

  if (style === 'halo') {
    // Without a path to lag along (trails, previews), the ring sits centred.
    drawHalo(ctx, 0, 0, 0, 0, sizePx, 0, color)
    ctx.restore()
    return
  }

  if (style === 'sprite') {
    ctx.restore()
    if (!drawKnight(ctx, x, y, sizePx, 'idle', 0)) drawCursor(ctx, x, y, sizePx, 'arrow')
    return
  }

  if (style === 'bobbing') {
    ctx.scale(sizePx, sizePx)
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(0.12, 0.9)
    ctx.quadraticCurveTo(0.14, 0.97, 0.2, 0.91)
    ctx.lineTo(0.38, 0.67)
    ctx.lineTo(0.69, 0.64)
    ctx.quadraticCurveTo(0.78, 0.63, 0.71, 0.56)
    ctx.closePath()
    ctx.lineJoin = 'round'
    ctx.lineWidth = 0.055
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = '#171717'
    ctx.fill()
    ctx.stroke()
    ctx.restore()
    return
  }

  if (style === 'hand') {
    // Original macOS-inspired pointing hand. Fingertip is the tracked hotspot;
    // the same vector artwork is used in preview and export at every scale.
    ctx.scale(sizePx / 24, sizePx / 24)
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.bezierCurveTo(-1.1, 0, -1.85, 0.85, -1.85, 2)
    ctx.lineTo(-1.85, 12)
    ctx.lineTo(-4.1, 9.85)
    ctx.bezierCurveTo(-5.05, 8.95, -6.4, 9.25, -6.65, 10.35)
    ctx.bezierCurveTo(-6.85, 11.05, -6.45, 11.7, -5.9, 12.55)
    ctx.lineTo(-2.6, 18.3)
    ctx.bezierCurveTo(-1.8, 19.75, -0.4, 20.4, -0.2, 22)
    ctx.lineTo(7.2, 22)
    ctx.bezierCurveTo(7.2, 20.6, 9.2, 18.65, 9.2, 16.4)
    ctx.lineTo(9.2, 10.1)
    ctx.bezierCurveTo(9.2, 8.05, 6.5, 8.05, 6.5, 10.1)
    ctx.lineTo(6.5, 8.55)
    ctx.bezierCurveTo(6.5, 6.65, 3.8, 6.65, 3.8, 8.55)
    ctx.lineTo(3.8, 7.6)
    ctx.bezierCurveTo(3.8, 5.75, 1.85, 5.75, 1.85, 7.6)
    ctx.lineTo(1.85, 2)
    ctx.bezierCurveTo(1.85, 0.85, 1.1, 0, 0, 0)
    ctx.closePath()
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.lineWidth = 1.05
    const porcelain = ctx.createLinearGradient(-3, 0, 6, 22)
    porcelain.addColorStop(0, '#fffefa')
    porcelain.addColorStop(0.6, '#f8f7f3')
    porcelain.addColorStop(1, '#dedfe2')
    ctx.fillStyle = porcelain
    ctx.strokeStyle = '#30343b'
    ctx.shadowColor = 'rgba(0, 0, 0, 0.20)'
    ctx.shadowBlur = sizePx * 0.055
    ctx.shadowOffsetY = sizePx * 0.035
    ctx.fill()
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
    ctx.shadowOffsetY = 0
    ctx.stroke()
    // Fine finger separations distinguish a pointing hand from a mitten.
    ctx.beginPath()
    ctx.moveTo(1.85, 8.4)
    ctx.lineTo(1.85, 12.7)
    ctx.moveTo(3.8, 9.1)
    ctx.lineTo(3.8, 13)
    ctx.moveTo(6.5, 10.7)
    ctx.lineTo(6.5, 13.3)
    ctx.lineWidth = 0.75
    ctx.stroke()
    ctx.restore()
    return
  }

  if (style === 'dot') {
    const r = sizePx * 0.3
    ctx.beginPath()
    ctx.arc(0, 0, r, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(20, 20, 20, 0.9)'
    ctx.fill()
    ctx.lineWidth = Math.max(1, sizePx * 0.1)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
    ctx.stroke()
    ctx.restore()
    return
  }

  // Arrow: white fill, black outline, tip at the hotspot. Drawn in unit space scaled
  // by sizePx; the stroke width is set in unit space so it scales with the sprite.
  ctx.scale(sizePx, sizePx)
  ctx.lineJoin = 'round'
  ctx.lineWidth = 0.06
  ctx.strokeStyle = '#000000'
  ctx.fillStyle = '#ffffff'
  const path = unitArrowPath()
  if (path) {
    ctx.stroke(path)
    ctx.fill(path)
  } else {
    traceArrow(ctx)
    ctx.stroke()
    ctx.fill()
  }
  ctx.restore()
}

// ---------------------------------------------------------------------------
// Ripples

/**
 * Expanding ring at a click. radiusPx is the ring radius at the end of life; it starts
 * at RIPPLE_MIN_RADIUS/RIPPLE_MAX_RADIUS of that (8 -> 40 when radiusPx is 40).
 * Alpha fades 0.8 -> 0. Draws nothing outside [0, lifeSec].
 */
/**
 * Dim the recording away from the pointer: clear around it, darkening to
 * `0.65 x strength` past `radius`. Drawn inside the card's clip, so the
 * background around the recording is left alone.
 */
export function drawSpotlight(ctx: Ctx2D, x: number, y: number, radius: number, strength: number): void {
  const k = Math.min(1, Math.max(0, strength))
  if (k <= 0 || !(radius > 0)) return
  const g = ctx.createRadialGradient(x, y, radius * 0.55, x, y, radius * 1.35)
  g.addColorStop(0, 'rgba(0, 0, 0, 0)')
  g.addColorStop(1, `rgba(0, 0, 0, ${(0.65 * k).toFixed(3)})`)
  ctx.save()
  ctx.fillStyle = g
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.restore()
}

export function drawRipple(
  ctx: Ctx2D,
  x: number,
  y: number,
  age: number,
  lifeSec: number,
  radiusPx: number,
  color = '#ffffff'
): void {
  if (!(lifeSec > 0) || age < 0 || age > lifeSec || !(radiusPx > 0)) return
  const p = age / lifeSec
  const minR = radiusPx * (RIPPLE_MIN_RADIUS / RIPPLE_MAX_RADIUS)
  const radius = minR + (radiusPx - minR) * easeOutCubic(p)
  const alpha = 0.8 * (1 - p)
  if (alpha <= 0) return
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(1, radiusPx * 0.09 * (1 - p * 0.5))
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

function easeOutCubic(p: number): number {
  const q = 1 - p
  return 1 - q * q * q
}

const RIPPLE_COLORS: Record<'left' | 'right' | 'middle', string> = {
  left: '#ffffff',
  right: '#8fd3ff',
  middle: '#ffe28a'
}

// ---------------------------------------------------------------------------
// Frame

// Reuse within one destination only, never across preview/export contexts.
function cardCanvas(owner: object, width: number, height: number): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D; width: number; height: number } {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const canvas = scratchCanvas(owner, 'tilt-card', w, h)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable')
  return { canvas, ctx, width: w, height: h }
}

function entranceProgress(project: Project, tSec: number): number {
  const { durationSec } = project.animation
  if (project.animation.style === 'none' || durationSec <= 0) return 1
  const trimStart = Number.isFinite(project.trim.start) ? project.trim.start : 0
  return Math.max(0, Math.min(1, (tSec - trimStart) / durationSec))
}

/** Apply the bounded entrance treatment to the complete presentation shell. */
export function applyEntranceAnimation(ctx: Ctx2D, project: Project, tSec: number, minSide: number): void {
  const animation = project.animation
  if (animation.style === 'none') return
  const p = entranceProgress(project, tSec)
  const eased = easeOutCubic(p)
  const strength = Math.max(0, Math.min(1, Number.isFinite(animation.strength) ? animation.strength : 0))
  const amount = 0.08 * strength
  ctx.globalAlpha *= animation.style === 'fade' ? eased : 1
  if (animation.style === 'rise') ctx.translate(0, minSide * amount * (1 - eased))
  if (animation.style === 'scale') {
    const scale = 1 - amount * (1 - eased)
    const cx = ctx.canvas.width / 2
    const cy = ctx.canvas.height / 2
    ctx.translate(cx, cy)
    ctx.scale(scale, scale)
    ctx.translate(-cx, -cy)
  }
}

const backgroundCache = new WeakMap<Ctx2D, { key: string; image: CanvasImageSource | null | undefined; canvas: OffscreenCanvas }>()
const shadowCache = new WeakMap<Ctx2D, { key: string; canvas: OffscreenCanvas }>()

export function renderBackground(ctx: Ctx2D, output: { width: number; height: number }, input: FrameInput): void {
  const background = input.project.background
  const blur = Math.min(60, Math.max(0, background.blur ?? 0))
  const brand = () => drawBackgroundBrand(ctx, output, brandImagePath(background), background.lettering === true, background.letteringPosition)
  // Lettering is painted on top of the finished background, so raising
  // Background blur softens the wallpaper without smearing the wordmark.
  if (blur === 0) { drawBackground(ctx, output, background, input.backgroundImage); brand(); return }
  const paint = (target: Ctx2D) => {
    target.save()
    if (blur > 0) {
      const pad = blur * 3
      target.filter = `blur(${blur}px)`
      target.translate(-pad, -pad)
      target.scale((output.width + pad * 2) / output.width, (output.height + pad * 2) / output.height)
    }
    drawBackground(target, output, background, input.backgroundImage)
    target.restore()
  }
  if (typeof OffscreenCanvas === 'undefined' || blur === 0) { paint(ctx); brand(); return }
  const key = JSON.stringify([output.width, output.height, background])
  let cached = backgroundCache.get(ctx)
  if (!cached || cached.key !== key || cached.image !== input.backgroundImage) {
    const canvas = scratchCanvas(ctx, 'static-background', output.width, output.height)
    const target = canvas.getContext('2d')
    if (!target) { paint(ctx); brand(); return }
    target.clearRect(0, 0, output.width, output.height)
    paint(target)
    cached = { key, image: input.backgroundImage, canvas }
    backgroundCache.set(ctx, cached)
  }
  ctx.drawImage(cached.canvas, 0, 0)
  brand()
}

export function renderFrame(ctx: Ctx2D, input: FrameInput): void {
  const { videoSize, project } = input
  if (!(videoSize.width > 0) || !(videoSize.height > 0)) return
  const output = { width: ctx.canvas.width, height: ctx.canvas.height }
  if (!(output.width > 0) || !(output.height > 0)) return

  // 1. Background.
  renderBackground(ctx, output, input)
  // The shell (card, webcam and overlays) enters as one composited unit; the
  // background stays stable and remains visible while the shell arrives.
  const animated = project.animation.style !== 'none'
  if (animated) {
    ctx.save()
    applyEntranceAnimation(ctx, project, input.tSec, Math.min(output.width, output.height))
  }

  // 2. Content and presentation-shell geometry, then camera mapping.
  const geometry = frameGeometry(input, output)
  const rect = geometry.rect
  if (!(rect.width > 0) || !(rect.height > 0)) {
    if (animated) ctx.restore()
    return
  }
  const { pointer, mapping } = geometry
  const size = frameSize(project)
  const radius = Math.max(0, (project.mockup.kind === 'none' ? project.frame.radius : project.mockup.radius * 0.45) * size)
  const overlays = input.overlays ?? project.overlays ?? []
  const overlayArgs = overlays.length > 0 ? overlayArgsFor(input, output, geometry) : null

  // 4. Shadow, then clip and draw the video. With a tilted camera the card is
  //    rendered flat into an offscreen canvas and composited with perspective.
  const minSide = Math.min(output.width, output.height)
  const shadow = Math.max(0, Math.min(1, project.frame.shadow))
  const tiltX = geometry.camera.tiltX ?? 0
  const tiltY = geometry.camera.tiltY ?? 0
  const tilted = hasTilt(tiltX, tiltY) && typeof OffscreenCanvas !== 'undefined'
  const unified = project.zoom.perspective === 'unified'
  const surfaceRect = unified ? geometry.outer : rect
  if (shadow > 0 && !(tilted && unified)) {
    const corner = project.mockup.kind === 'none' ? radius : project.mockup.radius * size
    const paintShadow = (target: Ctx2D) => {
      target.save()
      target.shadowColor = `rgba(0, 0, 0, ${(0.65 * shadow).toFixed(3)})`
      target.shadowBlur = shadow * minSide * 0.08
      target.shadowOffsetX = 0
      target.shadowOffsetY = shadow * minSide * 0.02
      target.fillStyle = '#000000'
      if (tilted && (unified || project.mockup.kind === 'none')) quadPath(target, projectCard(surfaceRect, tiltX, tiltY))
      else roundedRectPath(target, geometry.outer.x, geometry.outer.y, geometry.outer.width, geometry.outer.height, corner)
      target.fill()
      target.restore()
    }
    if (!tilted && typeof OffscreenCanvas !== 'undefined') {
      const key = JSON.stringify([output, geometry.outer, corner, shadow])
      let cached = shadowCache.get(ctx)
      if (!cached || cached.key !== key) {
        const canvas = scratchCanvas(ctx, 'card-shadow', output.width, output.height)
        const target = canvas.getContext('2d')!
        target.clearRect(0, 0, output.width, output.height)
        paintShadow(target)
        cached = { key, canvas }
        shadowCache.set(ctx, cached)
      }
      ctx.drawImage(cached.canvas, 0, 0)
    } else paintShadow(ctx)
  }

  const mockup = scaleMockupGeometry(shiftMockupGeometry(mockupGeometry(output, { width: geometry.crop.width, height: geometry.crop.height }, project.frame.padding, project.mockup), frameOffset(project, output)), size)
  if (!tilted || !unified) drawMockupChrome(ctx, mockup, { ...project.mockup, radius: project.mockup.radius * size })

  // Everything inside the card draws into `card`: the main context, or an
  // offscreen canvas translated so rect.x/rect.y land at 0,0.
  const target = tilted ? cardCanvas(ctx, surfaceRect.width, surfaceRect.height) : null
  const card: Ctx2D = target ? target.ctx : ctx
  /** A sprite pointer to draw once the card's clip is lifted (untilted only). */
  let knight: { x: number; y: number; size: number; pose: KnightPose; alpha: number } | null = null
  card.save()
  if (target) {
    card.clearRect(0, 0, target.width, target.height)
    card.translate(-surfaceRect.x, -surfaceRect.y)
    if (unified) drawMockupChrome(card, mockup, { ...project.mockup, radius: project.mockup.radius * size })
  }
  roundedRectPath(card, rect.x, rect.y, rect.width, rect.height, radius)
  card.clip()
  card.imageSmoothingEnabled = true
  card.imageSmoothingQuality = 'high'
  card.drawImage(
    input.video,
    geometry.crop.x,
    geometry.crop.y,
    geometry.crop.width,
    geometry.crop.height,
    mapping.tx,
    mapping.ty,
    mapping.scale * geometry.crop.width,
    mapping.scale * geometry.crop.height
  )

  // 6. Ripples go under the cursor so the pointer stays readable.
  if (project.cursor.ripple) {
    for (const r of ripplesAt(input.events, input.tSec, RIPPLE_LIFE_SEC)) {
      const local = sourceToCroppedPoint(r, geometry.crop)
      drawRipple(
        card,
        mapping.tx + mapping.scale * local.x,
        mapping.ty + mapping.scale * local.y,
        r.age,
        RIPPLE_LIFE_SEC,
        RIPPLE_MAX_RADIUS * mapping.scale,
        RIPPLE_COLORS[r.button] ?? '#ffffff'
      )
    }
  }

  // 6b. Pinned overlays live in video space: drawn inside the clip, under the cursor.
  if (overlayArgs) drawOverlays(card, overlays, { ...overlayArgs, which: 'pinned' })

  // 5. Cursor.
  if (pointer && project.cursor.size > 0) {
    if (!input.events.cursorBaked) {
      const localPointer = sourceToCroppedPoint(pointer, geometry.crop)
      const trim = effectiveTrim(project, input.duration ?? input.tSec)
      if (project.cursor.loop && trim.end > trim.start) {
        const first = smoothedPointerAt(input.pointerPath, trim.start)
        const p = Math.min(1, Math.max(0, (input.tSec - (trim.end - Math.min(0.8, (trim.end - trim.start) / 2))) / Math.min(0.8, (trim.end - trim.start) / 2)))
        if (first && p > 0) {
          const localFirst = sourceToCroppedPoint(first, geometry.crop)
          const ease = p * p * (3 - 2 * p)
          localPointer.x += (localFirst.x - localPointer.x) * ease
          localPointer.y += (localFirst.y - localPointer.y) * ease
        }
      }
      // A pointer parked in a still frame draws the eye to nothing; fade it
      // out while it rests, and bring it straight back on movement or a click.
      const cursorAlpha = cursorAlphaAt(input.pointerPath, input.events.clicks, input.tSec, project.cursor.idleHideSec)
      // Spotlight: dim the recording away from the pointer. It fades with the
      // pointer, so a resting take goes back to plain.
      if ((project.cursor.spotlight ?? 0) > 0 && cursorAlpha > 0.01) {
        drawSpotlight(
          card,
          mapping.tx + mapping.scale * localPointer.x,
          mapping.ty + mapping.scale * localPointer.y,
          0.18 * Math.min(input.videoSize.width, input.videoSize.height) * mapping.scale,
          (project.cursor.spotlight ?? 0) * cursorAlpha
        )
      }
      if (cursorAlpha > 0.01) {
      card.save()
      card.globalAlpha *= cursorAlpha
      const previous = smoothedPointerAt(input.pointerPath, Math.max(0, input.tSec - 0.035))
      const velocityX = previous ? pointer.x - previous.x : 0
      const lastClick = input.events.clicks.filter((c) => c.down && c.t <= input.tSec * 1000).at(-1)
      const age = lastClick ? input.tSec - lastClick.t / 1000 : 1
      const bobbing = project.cursor.style === 'bobbing'
      const hand = project.cursor.style === 'hand'
      const halo = project.cursor.style === 'halo'
      const star = project.cursor.style === 'star'
      const bounce = !bobbing && !hand && !halo && !star && project.cursor.bounce && age < 0.32 ? 1 - 0.22 * Math.sin(Math.PI * age / 0.32) : 1
      const trails = Math.round(Math.min(1, Math.max(0, project.cursor.motionBlur ?? 0)) * 5)
      for (let i = trails; i > 0; i--) {
        const past = smoothedPointerAt(input.pointerPath, Math.max(trim.start, input.tSec - i * 0.012))
        if (!past) continue
        const local = sourceToCroppedPoint(past, geometry.crop)
        card.save()
        card.globalAlpha *= 0.1 * (1 - i / (trails + 1))
        drawCursor(card, mapping.tx + mapping.scale * local.x, mapping.ty + mapping.scale * local.y, CURSOR_BASE_PX * project.cursor.size * mapping.scale, project.cursor.style, project.cursor.color)
        card.restore()
      }
      const px = mapping.tx + mapping.scale * localPointer.x
      const py = mapping.ty + mapping.scale * localPointer.y
      if (project.cursor.style === 'sprite') {
        // The knight carries its own motion: it floats at rest and casts on a
        // press, orb on the pointer. Sway and squash would tip it over. Keep
        // its presentation size in output space: camera zoom already enlarges
        // the page and must not enlarge the character a second time. Its body
        // hangs below the orb, so inside the card's clip it vanished near the
        // bottom edge; untilted, it is drawn after the clip is lifted.
        const presentationScale = mapping.scale / Math.max(geometry.camera.scale, 1e-6)
        knight = { x: px, y: py, size: CURSOR_BASE_PX * project.cursor.size * presentationScale, pose: knightPoseAt(age), alpha: cursorAlpha }
        if (target) {
          if (!drawKnight(card, knight.x, knight.y, knight.size, knight.pose, input.tSec)) drawCursor(card, knight.x, knight.y, knight.size, 'arrow')
          knight = null
        }
      } else if (star) {
        // The tail is the pointer's own recent path, drawn relative to the
        // star so it follows wherever the star is drawn.
        const size = CURSOR_BASE_PX * project.cursor.size * mapping.scale
        const localNow = sourceToCroppedPoint(pointer, geometry.crop)
        const at = (tSec: number) => {
          const p = smoothedPointerAt(input.pointerPath, Math.max(trim.start, tSec))
          if (!p) return null
          const local = sourceToCroppedPoint(p, geometry.crop)
          return { x: px + mapping.scale * (local.x - localNow.x), y: py + mapping.scale * (local.y - localNow.y) }
        }
        const tail: Array<{ x: number; y: number }> = [{ x: px, y: py }]
        for (let i = 1; i <= STAR_TRAIL_SAMPLES; i++) {
          const p = at(input.tSec - (i * STAR_TRAIL_SEC) / STAR_TRAIL_SAMPLES)
          if (p) tail.push(p)
        }
        drawStarTrail(card, tail, size, project.cursor.color, input.tSec)
        input.events.clicks.forEach((c, i) => {
          if (!c.down) return
          const clickAge = input.tSec - c.t / 1000
          if (clickAge < 0 || clickAge >= STAR_BURST_SEC) return
          const p = at(c.t / 1000)
          if (p) drawStarBurst(card, p.x, p.y, size, clickAge, i, project.cursor.color)
        })
        drawStar(card, px, py, size, project.cursor.color, input.tSec, haloPressAt(age))
      } else if (halo) {
        // The ring follows the dot along the same path a moment later, so it
        // trails a move and settles back over the dot when the pointer rests.
        const size = CURSOR_BASE_PX * project.cursor.size * mapping.scale
        const lagged = smoothedPointerAt(input.pointerPath, Math.max(trim.start, input.tSec - HALO_RING_LAG_SEC))
        const localLagged = lagged ? sourceToCroppedPoint(lagged, geometry.crop) : null
        const localNow = sourceToCroppedPoint(pointer, geometry.crop)
        const offset = localLagged
          ? haloRingOffset(mapping.scale * (localLagged.x - localNow.x), mapping.scale * (localLagged.y - localNow.y), size)
          : { dx: 0, dy: 0 }
        drawHalo(card, px, py, px + offset.dx, py + offset.dy, size, haloPressAt(age), project.cursor.color)
      } else {
      const sway = Math.min(1, Math.max(0, project.cursor.sway ?? 0))
      if (sway > 0 || bobbing || hand) {
        card.save()
        card.translate(px, py)
        card.rotate(Math.max(-0.3, Math.min(0.3, velocityX * 0.006)) * sway)
        if (hand) {
          const press = handPressAt(project.cursor.bounce ? age : Infinity)
          card.scale(press.scaleX, press.scaleY)
        }
        if (bobbing) {
          const motion = cursorBobAt(input.tSec, project.cursor.bounce ? age : Infinity)
          card.rotate(motion.rotation)
          card.scale(motion.scaleX, motion.scaleY)
        }
      }
      drawCursor(
        card,
        sway > 0 || bobbing || hand ? 0 : px,
        sway > 0 || bobbing || hand ? 0 : py,
        CURSOR_BASE_PX * project.cursor.size * mapping.scale * bounce,
        project.cursor.style,
        project.cursor.color
      )
      if (sway > 0 || bobbing || hand) card.restore()
      }
      card.restore()
      }
    }
  }
  card.restore()
  if (target) {
    if (unified) {
      // Cast from the actual alpha silhouette so rounded corners don't expose
      // a black quadrilateral behind the device. Composite the fallback once,
      // too: per-strip shadows would accumulate into dark seams.
      ctx.save()
      ctx.shadowColor = `rgba(0, 0, 0, ${(0.65 * shadow).toFixed(3)})`
      ctx.shadowBlur = shadow * minSide * 0.08
      ctx.shadowOffsetX = 0
      ctx.shadowOffsetY = shadow * minSide * 0.02
      if (!drawPerspective(ctx, target.canvas, surfaceRect, tiltX, tiltY)) {
        const fallback = scratchCanvas(ctx, 'perspective-fallback', output.width, output.height)
        const flat = fallback.getContext('2d')!
        flat.clearRect(0, 0, output.width, output.height)
        drawTilted(flat, target.canvas, { width: target.width, height: target.height }, surfaceRect, tiltX, tiltY)
        ctx.drawImage(fallback, 0, 0)
      }
      ctx.restore()
    } else drawTilted(ctx, target.canvas, { width: target.width, height: target.height }, rect, tiltX, tiltY)
  }
  const rider = knight
  if (rider) {
    ctx.save()
    ctx.globalAlpha *= rider.alpha
    if (!drawKnight(ctx, rider.x, rider.y, rider.size, rider.pose, input.tSec)) drawCursor(ctx, rider.x, rider.y, rider.size, 'arrow')
    ctx.restore()
  }

  // 7. Webcam bubble, untransformed.
  if (input.webcam && project.webcam.enabled) {
    const webcam = project.webcam.reactive ? { ...project.webcam, size: project.webcam.size / (1 + 0.25 * Math.max(0, geometry.camera.scale - 1)) } : project.webcam
    drawWebcam(ctx, output, input.webcam, webcam, minSide)
  }

  // 8. Screen-space overlays sit on top of everything.
  if (overlayArgs) drawOverlays(ctx, overlays, { ...overlayArgs, which: 'unpinned' })
  if (animated) ctx.restore()

  // 9. Captions: outside the entrance animation and the camera, so they hold still.
  drawCaptions(ctx, output, project.captions, input.tSec)
}

function drawWebcam(
  ctx: Ctx2D,
  output: { width: number; height: number },
  webcam: CanvasImageSource,
  cfg: Project['webcam'],
  minSide: number
): void {
  const rect = webcamRect(output, cfg)
  if (!(rect.width > 0) || !(rect.height > 0)) return
  const src = imageSourceSize(webcam)
  if (src.width <= 0 || src.height <= 0) return
  const radius = cfg.round ? Math.min(rect.width, rect.height) / 2 : Math.min(rect.width, rect.height) * 0.12

  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)'
  ctx.shadowBlur = minSide * 0.03
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = minSide * 0.008
  ctx.fillStyle = '#000000'
  roundedRectPath(ctx, rect.x, rect.y, rect.width, rect.height, radius)
  ctx.fill()
  ctx.restore()

  ctx.save()
  roundedRectPath(ctx, rect.x, rect.y, rect.width, rect.height, radius)
  ctx.clip()
  // Framing, backdrop and lighting all live in webcam-look; this stays
  // responsible only for the bubble's shape and shadow.
  drawWebcamLook({ ctx, webcam, source: src, rect, look: cfg.look ?? DEFAULT_WEBCAM_LOOK })
  ctx.restore()
}
