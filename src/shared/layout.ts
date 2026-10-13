// Output geometry: output size, content rect, webcam bubble, effective trim. Pure, no DOM.
import type { Project } from './types'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

type Size = { width: number; height: number }

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const even = (v: number): number => Math.max(2, Math.round(v / 2) * 2)

/** Output pixel size from the project aspect and height. Both dimensions are even. */
export function outputSize(project: Project, source: Size): Size {
  const height = project.output.height
  let ratio: number
  switch (project.output.aspect) {
    case '9:16':
      ratio = 9 / 16
      break
    case '1:1':
      ratio = 1
      break
    // The feed shape on Instagram and LinkedIn: taller than square, shorter than vertical.
    case '4:5':
      ratio = 4 / 5
      break
    // Slides and older screens.
    case '4:3':
      ratio = 4 / 3
      break
    case 'source':
      ratio = source.width > 0 && source.height > 0 ? source.width / source.height : 16 / 9
      break
    case '16:9':
    default:
      ratio = 16 / 9
  }
  return { width: even(height * ratio), height: even(height) }
}

/**
 * Where the recording is drawn: the output inset by `padding * min(side)` on
 * every side, then the source aspect fitted inside (letterboxed) and centred.
 */
export function contentRect(output: Size, source: Size, padding: number): Rect {
  const minSide = Math.min(output.width, output.height)
  const inset = clamp(Number.isFinite(padding) ? padding : 0, 0, 0.5) * minSide
  const availW = Math.max(0, output.width - 2 * inset)
  const availH = Math.max(0, output.height - 2 * inset)
  if (availW <= 0 || availH <= 0 || source.width <= 0 || source.height <= 0) {
    return { x: output.width / 2, y: output.height / 2, width: 0, height: 0 }
  }
  const scale = Math.min(availW / source.width, availH / source.height)
  const width = source.width * scale
  const height = source.height * scale
  return { x: (output.width - width) / 2, y: (output.height - height) / 2, width, height }
}

/** Fraction of the shorter output side between the bubble and the frame edge. */
export const WEBCAM_INSET = 0.03

/**
 * Square webcam bubble with side = `webcam.size * min(output side)`, inset 3%
 * of the shorter side from the chosen corner. Ignores `webcam.enabled`.
 */
export function webcamRect(output: Size, webcam: Project['webcam']): Rect {
  const minSide = Math.min(output.width, output.height)
  const side = clamp(webcam.size, 0, 1) * minSide
  const inset = WEBCAM_INSET * minSide
  const left = inset
  const right = output.width - inset - side
  const top = inset
  const bottom = output.height - inset - side
  switch (webcam.corner) {
    case 'tl':
      return { x: left, y: top, width: side, height: side }
    case 'tr':
      return { x: right, y: top, width: side, height: side }
    case 'bl':
      return { x: left, y: bottom, width: side, height: side }
    case 'br':
    default:
      return { x: right, y: bottom, width: side, height: side }
  }
}

/**
 * Trim range in seconds. `end` 0 means the full duration. Both ends are clamped
 * to [0, durationSec]; when they would collapse, `end` falls back to the
 * duration and, if `start` is still not before it, `start` to 0. Only a
 * non-positive duration yields end === start.
 */
export function effectiveTrim(project: Project, durationSec: number): { start: number; end: number } {
  const dur = Number.isFinite(durationSec) ? Math.max(0, durationSec) : 0
  let start = clamp(Number.isFinite(project.trim.start) ? project.trim.start : 0, 0, dur)
  const rawEnd = project.trim.end
  let end = !Number.isFinite(rawEnd) || rawEnd <= 0 ? dur : clamp(rawEnd, 0, dur)
  if (end <= start) end = dur
  if (end <= start) start = 0
  return { start, end }
}
