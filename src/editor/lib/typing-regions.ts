import type { Project } from '../../shared/types'

/** Typing plays this fast, easing in and out over a fifth of a second. */
export const TYPING_RATE = 3

/** New speed regions for typing `ranges`, skipping any that would overlap `existing` or be too short to matter. */
export function typingRegions(ranges: ReadonlyArray<{ start: number; end: number }>, existing: ReadonlyArray<{ start: number; end: number }>): NonNullable<Project['speedRegions']> {
  const out: NonNullable<Project['speedRegions']> = []
  for (const r of ranges) {
    const start = r.start + 0.1
    const end = r.end - 0.1
    if (end - start < 1 || [...existing, ...out].some((x) => start < x.end && end > x.start)) continue
    out.push({ id: crypto.randomUUID(), start, end, rate: TYPING_RATE, ease: Math.min(0.2, (end - start) / 4) })
  }
  return out
}
