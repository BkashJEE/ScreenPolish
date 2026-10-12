// Fake perspective for the framed content. Canvas 2D has no 3D transform, so
// a tilted card is drawn as many thin strips, each scaled to the projected
// height (or width) at that position. Up to roughly 15 degrees this is
// indistinguishable from a real projection at video resolution, and it works
// identically in preview and export because both use this same code.

import type { Rect } from '../shared/layout'

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export interface Point {
  x: number
  y: number
}

/** Projected corners of the card, clockwise from top-left, in output px. */
export interface CardQuad {
  tl: Point
  tr: Point
  br: Point
  bl: Point
}

export const DEFAULT_STRIPS = 96

/** Focal length relative to the larger card side; smaller = stronger perspective. */
export const FOCAL_FACTOR = 1.7

const rad = (deg: number): number => (deg * Math.PI) / 180

/**
 * Project a card lying in the z=0 plane, centred on `rect`, rotated by
 * `tiltX` degrees about the vertical axis (positive brings the LEFT edge
 * toward the viewer) and `tiltY` degrees about the horizontal axis (positive
 * brings the TOP edge toward the viewer). Viewer sits on the -z side at
 * distance f, so points with z < 0 grow.
 */
export function projectCard(rect: Rect, tiltX: number, tiltY: number, focalFactor = FOCAL_FACTOR): CardQuad {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  const f = Math.max(rect.width, rect.height) * focalFactor
  const ay = rad(tiltX)
  const ax = rad(tiltY)
  const cosY = Math.cos(ay)
  const sinY = Math.sin(ay)
  const cosX = Math.cos(ax)
  const sinX = Math.sin(ax)

  const project = (x: number, y: number): Point => {
    // Rotate about Y: left edge (x < 0) moves toward the viewer (z < 0) for tiltX > 0.
    const x1 = x * cosY
    const z1 = x * sinY
    // Rotate about X: top edge (y < 0) moves toward the viewer for tiltY > 0.
    const y2 = y * cosX
    const z2 = z1 + y * sinX
    const k = f / (f + z2)
    return { x: cx + x1 * k, y: cy + y2 * k }
  }

  const hw = rect.width / 2
  const hh = rect.height / 2
  return {
    tl: project(-hw, -hh),
    tr: project(hw, -hh),
    br: project(hw, hh),
    bl: project(-hw, hh)
  }
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/** Trace the projected outline (used for the shadow under a tilted card). */
export function quadPath(ctx: Ctx2D, q: CardQuad): void {
  ctx.beginPath()
  ctx.moveTo(q.tl.x, q.tl.y)
  ctx.lineTo(q.tr.x, q.tr.y)
  ctx.lineTo(q.br.x, q.br.y)
  ctx.lineTo(q.bl.x, q.bl.y)
  ctx.closePath()
}

export function hasTilt(tiltX?: number, tiltY?: number): boolean {
  return Math.abs(tiltX ?? 0) > 0.01 || Math.abs(tiltY ?? 0) > 0.01
}

/** Most strips a tilt is drawn with, however steep. */
export const MAX_STRIPS = 256
/** How far one strip's edge may move across its width before more strips are used. */
const MAX_STRIP_STEP_PX = 0.5
/** How far each strip repeats its edge row past the card's edge, for the clip to cut cleanly. */
const EDGE_BLEED_PX = 2

/**
 * Clip to the two edges the strips step along, as exact lines, leaving the
 * other two sides alone: those are the strips' own straight ends.
 * `a0 → a1` and `b0 → b1` are the stepping edges, extended `margin` px past
 * both ends so the clip never cuts into a side.
 */
function clipToEdges(ctx: Ctx2D, a0: Point, a1: Point, b1: Point, b0: Point, margin: number): void {
  const out = (from: Point, to: Point): Point => {
    const len = Math.hypot(to.x - from.x, to.y - from.y) || 1
    return { x: to.x + ((to.x - from.x) / len) * margin, y: to.y + ((to.y - from.y) / len) * margin }
  }
  ctx.beginPath()
  const p = [out(a1, a0), out(a0, a1), out(b0, b1), out(b1, b0)]
  ctx.moveTo(p[0]!.x, p[0]!.y)
  for (const q of p.slice(1)) ctx.lineTo(q.x, q.y)
  ctx.closePath()
  ctx.clip()
}

/**
 * Draw `source` (an already rendered, rect-sized card with transparent
 * corners) onto `ctx` with the perspective described by the tilt angles.
 * Strips run vertically when the dominant tilt is about the vertical axis,
 * horizontally otherwise.
 *
 * Each strip's end is flat, so on their own the sloped edges come out as a
 * staircase. Every strip therefore repeats its edge row a little past the
 * edge, and an anti-aliased clip along the exact edge line trims it: the edge
 * is drawn by the clip, smoothly, rather than by the strips. More strips are
 * used when a steep tilt would make each step large.
 */
export function drawTilted(
  ctx: Ctx2D,
  source: CanvasImageSource,
  sourceSize: { width: number; height: number },
  rect: Rect,
  tiltX: number,
  tiltY: number,
  strips = DEFAULT_STRIPS
): CardQuad {
  const q = projectCard(rect, tiltX, tiltY)
  const sw = sourceSize.width
  const sh = sourceSize.height
  const vertical = Math.abs(tiltX) >= Math.abs(tiltY)
  const drift = vertical
    ? Math.max(Math.abs(q.tr.y - q.tl.y), Math.abs(q.br.y - q.bl.y))
    : Math.max(Math.abs(q.bl.x - q.tl.x), Math.abs(q.br.x - q.tr.x))
  const n = Math.min(MAX_STRIPS, Math.max(1, Math.round(strips), Math.ceil(drift / MAX_STRIP_STEP_PX)))
  const margin = Math.max(rect.width, rect.height)
  ctx.save()
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  if (vertical) {
    // Vertical strips: walk left to right. Each strip's top and bottom come from
    // the projected top and bottom edges at the middle of the strip.
    clipToEdges(ctx, q.tl, q.tr, q.br, q.bl, margin)
    for (let i = 0; i < n; i++) {
      const u0 = i / n
      const u1 = (i + 1) / n
      const um = (u0 + u1) / 2
      const xa = lerp(q.tl.x, q.tr.x, u0)
      const xb = lerp(q.tl.x, q.tr.x, u1)
      const top = lerp(q.tl.y, q.tr.y, um)
      const bottom = lerp(q.bl.y, q.br.y, um)
      // +0.6 px overlap hides seams between strips after smoothing.
      const dw = xb - xa + 0.6
      const sx = u0 * sw
      const sliceW = Math.max(1, sw / n)
      ctx.drawImage(source, sx, 0, sliceW, sh, xa, top, dw, bottom - top)
      ctx.drawImage(source, sx, 0, sliceW, 1, xa, top - EDGE_BLEED_PX, dw, EDGE_BLEED_PX)
      ctx.drawImage(source, sx, sh - 1, sliceW, 1, xa, bottom, dw, EDGE_BLEED_PX)
    }
  } else {
    clipToEdges(ctx, q.tl, q.bl, q.br, q.tr, margin)
    for (let i = 0; i < n; i++) {
      const v0 = i / n
      const v1 = (i + 1) / n
      const vm = (v0 + v1) / 2
      const ya = lerp(q.tl.y, q.bl.y, v0)
      const yb = lerp(q.tl.y, q.bl.y, v1)
      const left = lerp(q.tl.x, q.bl.x, vm)
      const right = lerp(q.tr.x, q.br.x, vm)
      const dh = yb - ya + 0.6
      const sy = v0 * sh
      const sliceH = Math.max(1, sh / n)
      ctx.drawImage(source, 0, sy, sw, sliceH, left, ya, right - left, dh)
      ctx.drawImage(source, 0, sy, 1, sliceH, left - EDGE_BLEED_PX, ya, EDGE_BLEED_PX, dh)
      ctx.drawImage(source, sw - 1, sy, 1, sliceH, right, ya, EDGE_BLEED_PX, dh)
    }
  }
  ctx.restore()
  return q
}

/** Bounding box of a projected quad, for hit testing and shadow bounds. */
export function quadBounds(q: CardQuad): Rect {
  const xs = [q.tl.x, q.tr.x, q.br.x, q.bl.x]
  const ys = [q.tl.y, q.tr.y, q.br.y, q.bl.y]
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}
