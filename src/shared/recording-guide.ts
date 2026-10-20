/**
 * The recording guide: a planned take's steps, shown one at a time while it
 * records, so you know where to click next and which caption that part of
 * the video will carry.
 *
 * Each click inside the recording moves the guide to the next step (presses
 * closer together than GUIDE_STEP_GAP_MS count once, like the caption timing
 * does), and Back and Next fix a step the clicks got wrong. Every time the
 * guide moves on, the moment is marked in the take's input log; the planned
 * captions are then timed to those marks, so caption N appears exactly when
 * step N began, however many extra clicks it took.
 *
 * Pure: the recording session holds the state and the times.
 */

export interface GuideStep {
  /** What to do on screen. */
  action: string
  /** The caption the video shows during this step, if the plan wrote one. */
  caption?: string
}

export interface GuideState {
  steps: GuideStep[]
  /** The step being done now. */
  index: number
  /** Recording milliseconds at which steps 2, 3, … began. */
  marks: number[]
}

/** Presses closer than this move the guide once (a double click, a quick fix-up). */
export const GUIDE_STEP_GAP_MS = 1200
export const MAX_GUIDE_STEPS = 30

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')

/** The guide's steps from a plan's shot list and captions, paired in order. */
export function guideSteps(shots: ReadonlyArray<{ action: string }>, captions: readonly string[]): GuideStep[] {
  const n = Math.min(MAX_GUIDE_STEPS, Math.max(shots.length, captions.length))
  const steps: GuideStep[] = []
  for (let i = 0; i < n; i++) {
    const caption = text(captions[i], 120)
    const action = text(shots[i]?.action, 160) || caption
    if (!action) continue
    steps.push({ action, ...(caption ? { caption } : {}) })
  }
  return steps
}

/** Steps that crossed IPC, checked again. */
export function normalizeGuideSteps(raw: unknown): GuideStep[] {
  if (!Array.isArray(raw)) return []
  return guideSteps(
    raw.map((s) => ({ action: text((s as GuideStep | null)?.action, 160) })),
    raw.map((s) => text((s as GuideStep | null)?.caption, 120))
  )
}

export function startGuide(steps: readonly GuideStep[]): GuideState | null {
  return steps.length ? { steps: [...steps], index: 0, marks: [] } : null
}

/**
 * The guide after a move at recording time `tMs`: `next` from a click or the
 * Next button, `back` from the Back button. A click too soon after the last
 * move, or past the last step, changes nothing.
 */
export function moveGuide(state: GuideState, move: 'click' | 'next' | 'back', tMs: number): GuideState {
  if (move === 'back') {
    if (state.index === 0) return state
    return { ...state, index: state.index - 1, marks: state.marks.slice(0, -1) }
  }
  if (state.index >= state.steps.length - 1) return state
  const last = state.marks.at(-1)
  if (move === 'click' && last !== undefined && tMs - last < GUIDE_STEP_GAP_MS) return state
  // A mark never goes back in time, even if the clock was paused and resumed oddly.
  const t = Math.max(tMs, last ?? 0)
  return { ...state, index: state.index + 1, marks: [...state.marks, t] }
}
