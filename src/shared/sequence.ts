/**
 * Sequences: one export made of several takes, one after another.
 *
 * A take (a recording folder with its project.json) stays exactly what it is:
 * its trim, cuts, speed, zooms, overlays, captions and look all live on its own
 * source clock and are rendered by the per-take renderer as today. A sequence
 * only says which takes, in which order, which part of each, and how each one
 * hands over to the next. So it needs nothing from a take but the length of its
 * output: sequence time is the running total of clip lengths, less the overlap
 * each crossfade takes.
 *
 * Clip in and out points are on the take's OUTPUT clock (after its own cuts
 * and speed), the same seconds its export runs for, which is what the sequence
 * renderer cuts from.
 *
 * Saved as sequence.json in its own folder under the recordings root. Takes
 * are referred to by folder name, so the whole recordings folder can move.
 *
 * Pure, and tested like cuts.ts.
 */

export const SEQUENCE_FILE = 'sequence.json'

/** How a clip hands over to the next: a hard cut, or a crossfade of `durationSec`. */
export type SequenceTransitionStyle = 'none' | 'dissolve'

export interface SequenceTransition {
  style: SequenceTransitionStyle
  durationSec: number
}

export const DEFAULT_SEQUENCE_TRANSITION: SequenceTransition = { style: 'dissolve', durationSec: 0.5 }
export const MIN_SEQUENCE_TRANSITION_SEC = 0.1
export const MAX_SEQUENCE_TRANSITION_SEC = 2
/** No clip is trimmed shorter than this, so every clip stays visible and selectable. */
export const MIN_SEQUENCE_CLIP_SEC = 0.5
export const MAX_SEQUENCE_CLIPS = 50

/** A clip that plays part of a recording. Later milestones add title cards and imported media. */
export interface RecordingClip {
  id: string
  kind: 'recording'
  /** The recording's folder name under the recordings root. */
  take: string
  /** Seconds on the take's output clock where the clip starts. */
  in: number
  /** Where it ends on that clock; null plays to the end of the take. */
  out: number | null
  /** Into the next clip; absent or 'none' is a hard cut. Ignored on the last clip. */
  transition?: SequenceTransition
}

export type SequenceClip = RecordingClip

export interface Sequence {
  version: 1
  title: string
  clips: SequenceClip[]
}

/** Where one clip sits: its part of the take and its place on the sequence clock. */
export interface PlacedClip {
  index: number
  clip: SequenceClip
  /** Clamped in and out on the take's output clock. */
  in: number
  out: number
  /** Sequence seconds the clip starts and ends. A crossfade makes neighbours overlap. */
  start: number
  end: number
  /** Seconds this clip overlaps the next one (the crossfade into it); 0 for a hard cut and on the last clip. */
  overlapNext: number
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

let idCounter = 0
/** A clip id: unique within a sequence, and stable once saved. */
export function newClipId(): string {
  idCounter = (idCounter + 1) % 1_000_000
  return `clip-${Date.now().toString(36)}-${idCounter.toString(36)}`
}

export function normalizeTransition(value: unknown): SequenceTransition | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Partial<SequenceTransition>
  // Cut transitions inside a take also offer blur; between takes it reads as a crossfade.
  const style: SequenceTransitionStyle = v.style === 'dissolve' || (v.style as string) === 'blur' ? 'dissolve' : 'none'
  if (style === 'none') return { style, durationSec: DEFAULT_SEQUENCE_TRANSITION.durationSec }
  const d = finite(v.durationSec) ? v.durationSec : DEFAULT_SEQUENCE_TRANSITION.durationSec
  return { style, durationSec: clamp(d, MIN_SEQUENCE_TRANSITION_SEC, MAX_SEQUENCE_TRANSITION_SEC) }
}

/** A sequence from whatever was on disk: unusable clips dropped, ids made unique, numbers made sane. */
export function normalizeSequence(raw: unknown): Sequence {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Sequence>
  const seen = new Set<string>()
  const clips: SequenceClip[] = []
  for (const c of Array.isArray(r.clips) ? r.clips : []) {
    if (!c || typeof c !== 'object') continue
    const clip = c as Partial<RecordingClip>
    if ((clip.kind ?? 'recording') !== 'recording') continue
    const take = typeof clip.take === 'string' ? clip.take.trim() : ''
    // A folder name, never a path: a sequence must not reach outside the recordings folder.
    if (!take || take.includes('/') || take.includes('\\') || take === '.' || take === '..') continue
    let id = typeof clip.id === 'string' && clip.id ? clip.id : newClipId()
    while (seen.has(id)) id = newClipId()
    seen.add(id)
    const inSec = finite(clip.in) ? Math.max(0, clip.in) : 0
    const out = finite(clip.out) && clip.out > inSec ? clip.out : null
    const transition = normalizeTransition(clip.transition)
    clips.push({ id, kind: 'recording', take, in: inSec, out, ...(transition ? { transition } : {}) })
    if (clips.length >= MAX_SEQUENCE_CLIPS) break
  }
  const title = typeof r.title === 'string' ? r.title.replace(/\s+/g, ' ').trim().slice(0, 120) : ''
  return { version: 1, title, clips }
}

/** A new sequence that plays each take whole, in the order given, joined by the default crossfade. */
export function createSequence(takes: readonly string[], title = ''): Sequence {
  return normalizeSequence({
    version: 1,
    title,
    clips: takes.map((take) => ({ id: newClipId(), kind: 'recording', take, in: 0, out: null, transition: { ...DEFAULT_SEQUENCE_TRANSITION } }))
  })
}

/** The clip's in and out, clamped to a take of `takeLength` output seconds. */
export function clipRange(clip: SequenceClip, takeLength: number): { in: number; out: number } {
  const len = Math.max(0, finite(takeLength) ? takeLength : 0)
  const inSec = clamp(clip.in, 0, len)
  const out = clamp(clip.out ?? len, inSec, len)
  return { in: inSec, out }
}

/**
 * Every clip placed on the sequence clock. `takeLengths[i]` is the output
 * length of clip i's take. A crossfade overlaps the two clips by its length,
 * but never by more than half of either, so each clip keeps a moment of its own.
 */
export function placeClips(sequence: Sequence, takeLengths: readonly number[]): PlacedClip[] {
  const ranges = sequence.clips.map((clip, i) => clipRange(clip, takeLengths[i] ?? 0))
  const placed: PlacedClip[] = []
  let cursor = 0
  sequence.clips.forEach((clip, i) => {
    const r = ranges[i]!
    const len = r.out - r.in
    const next = ranges[i + 1]
    const t = clip.transition
    const overlapNext =
      next && t && t.style !== 'none' ? Math.max(0, Math.min(t.durationSec, len / 2, (next.out - next.in) / 2)) : 0
    placed.push({ index: i, clip, in: r.in, out: r.out, start: cursor, end: cursor + len, overlapNext })
    cursor += len - overlapNext
  })
  return placed
}

/** Length of the whole sequence in seconds. */
export function sequenceDuration(sequence: Sequence, takeLengths: readonly number[]): number {
  const placed = placeClips(sequence, takeLengths)
  return placed.length ? placed.at(-1)!.end : 0
}

export interface SequencePosition {
  clipIndex: number
  /** Seconds on that clip's take output clock. */
  localTime: number
  /** During a crossfade: the clip fading out, and how far the fade has gone (0..1). */
  fadingOut?: { clipIndex: number; localTime: number; progress: number }
}

/**
 * Which clip plays at sequence time `t`, and where in its take. During a
 * crossfade the incoming clip is the one returned, with the outgoing one in
 * `fadingOut`. Times outside the sequence clamp to its first or last frame.
 */
export function clipAtSequenceTime(sequence: Sequence, takeLengths: readonly number[], t: number): SequencePosition | null {
  const placed = placeClips(sequence, takeLengths)
  if (!placed.length) return null
  const time = clamp(finite(t) ? t : 0, 0, placed.at(-1)!.end)
  // The last clip that has started; overlaps resolve to the incoming one.
  let i = 0
  for (let k = 0; k < placed.length; k++) if (placed[k]!.start <= time + 1e-9) i = k
  const cur = placed[i]!
  const pos: SequencePosition = { clipIndex: i, localTime: Math.min(cur.out, cur.in + (time - cur.start)) }
  const prev = placed[i - 1]
  if (prev && prev.overlapNext > 0 && time < prev.end) {
    pos.fadingOut = {
      clipIndex: i - 1,
      localTime: Math.min(prev.out, prev.in + (time - prev.start)),
      progress: clamp((time - cur.start) / prev.overlapNext, 0, 1)
    }
  }
  return pos
}

/**
 * Ripple-trim the end of clip `index` by `delta` seconds (negative shortens),
 * clamped so the clip stays at least MIN_SEQUENCE_CLIP_SEC and within its take.
 * Clips after it keep their own in and out and simply move with it, since a
 * sequence has no gaps. Returns the new sequence and the shift actually applied
 * to everything after the clip.
 */
export function rippleAfter(sequence: Sequence, takeLengths: readonly number[], index: number, delta: number): { sequence: Sequence; shift: number } {
  const clip = sequence.clips[index]
  if (!clip || !finite(delta) || delta === 0) return { sequence, shift: 0 }
  const r = clipRange(clip, takeLengths[index] ?? 0)
  const len = Math.max(0, takeLengths[index] ?? 0)
  const out = clamp(r.out + delta, Math.min(len, r.in + MIN_SEQUENCE_CLIP_SEC), len)
  const shift = out - r.out
  if (shift === 0) return { sequence, shift: 0 }
  const clips = sequence.clips.map((c, i) => (i === index ? { ...c, out: out >= len - 1e-6 ? null : out } : c))
  return { sequence: { ...sequence, clips }, shift }
}

/** The sequence with clip `from` moved to position `to`. */
export function moveClip(sequence: Sequence, from: number, to: number): Sequence {
  if (from === to || !sequence.clips[from]) return sequence
  const clips = [...sequence.clips]
  const [clip] = clips.splice(from, 1)
  clips.splice(clamp(to, 0, clips.length), 0, clip!)
  return { ...sequence, clips }
}

export function removeSequenceClip(sequence: Sequence, index: number): Sequence {
  if (!sequence.clips[index]) return sequence
  return { ...sequence, clips: sequence.clips.filter((_, i) => i !== index) }
}

export function setClipTransition(sequence: Sequence, index: number, transition: SequenceTransition): Sequence {
  const t = normalizeTransition(transition)
  if (!sequence.clips[index] || !t) return sequence
  return { ...sequence, clips: sequence.clips.map((c, i) => (i === index ? { ...c, transition: t } : c)) }
}

/** The takes a sequence uses, once each, in first-use order. */
export function sequenceTakes(sequence: Sequence): string[] {
  return [...new Set(sequence.clips.map((c) => c.take))]
}
