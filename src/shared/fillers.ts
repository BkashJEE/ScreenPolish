import type { CaptionCue } from './captions'
import type { Cut } from './cuts'

/**
 * Filler words: the "um"s and "uh"s, found by the times the transcriber gave
 * each word and removed as cuts the same way quiet stretches are, so they can
 * be put back as a group. Only lines that still carry the transcriber's word
 * times are used; an estimated time could cut into a real word.
 */

export const FILLER_CUT_PREFIX = 'filler-'
/** Sounds, not words: "like" and "so" carry meaning too often to cut blind. */
export const FILLER_WORDS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'erm', 'er', 'ah', 'ahh', 'hmm', 'hm', 'mm', 'mmm'])
/** Kept either side of a filler so the cut does not clip the words around it. */
export const FILLER_PAD_SEC = 0.03

export const isFiller = (word: string): boolean => FILLER_WORDS.has(word.toLowerCase().replace(/[^a-z]/g, ''))

/** The stretches to cut: each filler with a little air, neighbours merged. */
export function findFillers(cues: readonly CaptionCue[]): Array<{ start: number; end: number; word: string }> {
  const found: Array<{ start: number; end: number; word: string }> = []
  for (const cue of cues) {
    for (const w of cue.words ?? []) {
      if (!isFiller(w.text) || !(w.end > w.start)) continue
      const start = Math.max(0, w.start - FILLER_PAD_SEC)
      const end = w.end + FILLER_PAD_SEC
      const last = found.at(-1)
      if (last && start <= last.end) {
        last.end = Math.max(last.end, end)
        last.word = `${last.word} ${w.text}`
      } else found.push({ start, end, word: w.text })
    }
  }
  return found
}

/** How many filler cuts are in place, and how much time they take out. */
export function fillerSummary(cuts: readonly Cut[] | undefined): { count: number; seconds: number } {
  const fillers = (cuts ?? []).filter((c) => c.id.startsWith(FILLER_CUT_PREFIX))
  return { count: fillers.length, seconds: fillers.reduce((a, c) => a + (c.end - c.start), 0) }
}
