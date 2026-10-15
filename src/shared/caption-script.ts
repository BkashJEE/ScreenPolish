import { CAPTION_LINE_CHARS, type CaptionCue } from './captions'

/**
 * Captions from a script: words the user wrote, timed to the take instead of
 * transcribed from it. That is how a take without a voice gets captions, and
 * how a narrated one gets exactly the wording it was meant to have.
 *
 * Each line of the script is a caption; a line too long for two caption lines
 * is split at sentence ends, then between words. Lines start at the clicks
 * (each click is a step being shown) or are spread evenly over the take. A
 * caption stays up until the next one, but not much past the time it takes to
 * read. Word timings are left out, so the word styles estimate them.
 */

export type ScriptTiming = 'clicks' | 'even'

/** Longest caption made from a script: what fits on the two lines a caption shows. */
export const SCRIPT_CHUNK_CHARS = CAPTION_LINE_CHARS * 2
/** Comfortable reading pace for on-screen text. */
export const READ_WORDS_PER_SEC = 2.6
export const MIN_CUE_SEC = 1.2
/** A caption left up longer than this, with nothing said, reads as stuck. */
export const MAX_CUE_SEC = 7
/** Presses closer than this are one step (a double click, a quick fix-up). */
export const STEP_GAP_SEC = 1.2
/** Captions appear a moment before their click, so the eye is there first. */
export const CUE_LEAD_SEC = 0.15
/** A first click later than this leaves room for an opening line at the start. */
export const OPENING_SEC = 2

/** The script cut into captions, in order. */
export function scriptChunks(script: string, maxChars = SCRIPT_CHUNK_CHARS): string[] {
  const out: string[] = []
  for (const raw of script.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim()
    if (!line) continue
    if (line.length <= maxChars) {
      out.push(line)
      continue
    }
    // Sentences first, then words, so a split lands somewhere a reader would pause.
    const sentences = line.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [line]
    let chunk = ''
    const flush = () => {
      if (chunk) out.push(chunk)
      chunk = ''
    }
    for (const sentence of sentences) {
      if (sentence.length > maxChars) {
        flush()
        for (const word of sentence.split(' ')) {
          if (chunk && chunk.length + 1 + word.length > maxChars) flush()
          chunk = chunk ? `${chunk} ${word}` : word
        }
        flush()
      } else if (chunk && chunk.length + 1 + sentence.length > maxChars) {
        flush()
        chunk = sentence
      } else chunk = chunk ? `${chunk} ${sentence}` : sentence
    }
    flush()
  }
  return out
}

/** Seconds a caption needs to be read. */
export function readingSec(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length
  return Math.max(MIN_CUE_SEC, words / READ_WORDS_PER_SEC)
}

/** Click times inside `range`, with presses close together counted once. */
export function stepTimes(clicks: readonly number[], range: { start: number; end: number }, gap = STEP_GAP_SEC): number[] {
  const steps: number[] = []
  for (const t of [...clicks].sort((a, b) => a - b)) {
    if (t < range.start || t >= range.end - MIN_CUE_SEC) continue
    if (steps.length && t - steps.at(-1)! < gap) continue
    steps.push(t)
  }
  return steps
}

/** When each of `n` captions starts, spread over `anchors` (each owns the time until the next). */
function startsFrom(anchors: readonly number[], n: number, end: number): number[] {
  const starts: number[] = []
  const a = anchors.length
  for (let i = 0; i < n; i++) {
    if (a >= n) {
      starts.push(anchors[Math.floor((i * a) / n)]!)
      continue
    }
    // Fewer anchors than captions: each anchor's stretch is shared by its captions.
    const g = Math.floor((i * a) / n)
    const first = Math.ceil((g * n) / a)
    const count = Math.ceil(((g + 1) * n) / a) - first
    const from = anchors[g]!
    const to = g + 1 < a ? anchors[g + 1]! : end
    starts.push(from + ((to - from) * (i - first)) / count)
  }
  return starts
}

/**
 * Captions for `script` over `range` (source seconds). `clicks` are press
 * times in source seconds; with none, or with timing 'even', the captions are
 * spread evenly.
 */
export function scriptCues(script: string, range: { start: number; end: number }, timing: ScriptTiming, clicks: readonly number[] = [], idPrefix = 'script'): CaptionCue[] {
  const chunks = scriptChunks(script)
  const span = range.end - range.start
  if (chunks.length === 0 || span <= 0) return []
  let anchors: number[]
  const steps = timing === 'clicks' ? stepTimes(clicks, range) : []
  if (steps.length > 0) {
    anchors = steps[0]! - range.start > OPENING_SEC ? [range.start, ...steps] : steps
  } else {
    anchors = chunks.map((_, i) => range.start + (span * i) / chunks.length)
  }
  const starts: number[] = []
  for (const [i, s] of startsFrom(anchors, chunks.length, range.end).entries()) {
    starts.push(i === 0 ? s : Math.max(starts[i - 1]! + 0.3, s - CUE_LEAD_SEC))
  }
  return chunks.map((text, i) => {
    const start = starts[i]!
    const next = i + 1 < starts.length ? starts[i + 1]! - 0.05 : range.end
    const end = Math.min(next, range.end, start + Math.max(MAX_CUE_SEC, readingSec(text)))
    return { id: `${idPrefix}-${i}`, start, end: Math.max(end, Math.min(range.end, start + 0.3)), text }
  })
}
