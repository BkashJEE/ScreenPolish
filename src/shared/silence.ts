/**
 * Silence removal: find the quiet stretches of a take and remove them as clips.
 *
 * Works on a loudness level per short window (dBFS), computed by the editor
 * from the recorded audio. A stretch counts as silence when every window stays
 * under the threshold for at least `minSec`; a blip shorter than `bridgeSec`
 * (a key click, a breath) does not break it. Each stretch is shrunk by `padSec`
 * at every edge that meets sound, so a word's first and last syllables are
 * never clipped.
 *
 * The result is plain cut ranges on the clip slicer's model, so each removed
 * stretch shows as a clip that can be restored on its own, playback and export
 * skip it, and a cut transition covers the join.
 */

import { MIN_CLIP_LENGTH, normalizeCuts, splitAt, type Cut } from './cuts'

export interface SilenceOptions {
  /** Windows quieter than this, in dBFS, are silent. */
  thresholdDb: number
  /** Shortest stretch worth removing, in seconds, before padding. */
  minSec: number
  /** Kept on each side that meets sound, in seconds. */
  padSec: number
  /** Louder blips shorter than this do not end a silence, in seconds. */
  bridgeSec: number
}

export const DEFAULT_SILENCE: SilenceOptions = { thresholdDb: -42, minSec: 0.8, padSec: 0.15, bridgeSec: 0.12 }

export const SILENCE_THRESHOLD_RANGE = { min: -60, max: -20 } as const
export const SILENCE_MIN_RANGE = { min: 0.3, max: 3 } as const

/** Cuts made by silence removal carry this id prefix, so they can be put back as a group. */
export const SILENCE_CUT_PREFIX = 'silence-'

/** Level of silence in dBFS; also what a window of digital zero reports. */
export const FLOOR_DB = -100

type Range = { start: number; end: number }

/** RMS level of interleaved or mono samples, in dBFS, floored at FLOOR_DB. */
export function rmsDb(samples: ArrayLike<number>, from = 0, to = samples.length): number {
  const n = to - from
  if (n <= 0) return FLOOR_DB
  let sum = 0
  for (let i = from; i < to; i++) sum += samples[i] * samples[i]
  const rms = Math.sqrt(sum / n)
  return rms > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(rms)) : FLOOR_DB
}

/**
 * Silent stretches of `range`, in source seconds. `levelsDb[i]` is the level of
 * source time [i * windowSec, (i + 1) * windowSec).
 */
export function findSilences(levelsDb: ArrayLike<number>, windowSec: number, range: Range, options: SilenceOptions = DEFAULT_SILENCE): Range[] {
  if (!(windowSec > 0) || !(range.end > range.start)) return []
  const first = Math.max(0, Math.floor(range.start / windowSec))
  const last = Math.min(levelsDb.length, Math.ceil(range.end / windowSec))
  const bridge = Math.max(0, Math.round(options.bridgeSec / windowSec))

  // Runs of quiet windows, joining runs split by a short loud blip.
  const runs: Array<[number, number]> = []
  let runStart = -1
  let loudSince = -1
  for (let i = first; i < last; i++) {
    const quiet = !(levelsDb[i] >= options.thresholdDb)
    if (quiet) {
      if (runStart < 0) runStart = i
      loudSince = -1
    } else if (runStart >= 0) {
      if (loudSince < 0) loudSince = i
      if (i - loudSince + 1 > bridge) {
        runs.push([runStart, loudSince])
        runStart = -1
        loudSince = -1
      }
    }
  }
  if (runStart >= 0) runs.push([runStart, loudSince >= 0 ? loudSince : last])

  const out: Range[] = []
  for (const [a, b] of runs) {
    const start = Math.max(range.start, a * windowSec)
    const end = Math.min(range.end, b * windowSec)
    if (end - start < options.minSec) continue
    // Pad only edges that meet sound; the trim's own edges have nothing to protect.
    const padStart = start > range.start + 1e-9 ? options.padSec : 0
    const padEnd = end < range.end - 1e-9 ? options.padSec : 0
    const s = start + padStart
    const e = end - padEnd
    if (e - s >= MIN_CLIP_LENGTH) out.push({ start: s, end: e })
  }
  return out
}

/**
 * Remove `silences` as clips: slice at each edge and cut the range. Returns
 * the new cuts and splits. Existing cuts are kept; overlapping ones merge.
 */
export function removeSilences(silences: readonly Range[], cuts: readonly Cut[] | undefined, splits: readonly number[] | undefined, trim: Range, prefix = SILENCE_CUT_PREFIX): { cuts: Cut[]; splits: number[] } {
  let nextSplits = [...(splits ?? [])]
  const added: Cut[] = []
  for (const s of silences) {
    nextSplits = splitAt(s.start, nextSplits, trim)
    nextSplits = splitAt(s.end, nextSplits, trim)
    added.push({ id: `${prefix}${Math.round(s.start * 1000)}-${Math.round(s.end * 1000)}`, start: s.start, end: s.end })
  }
  return { cuts: normalizeCuts([...(cuts ?? []), ...added]), splits: nextSplits }
}

/**
 * Put every silence cut back, and the slices it added, keeping the user's own
 * cuts. `prefix` picks another kind of generated cut (filler words use their own).
 */
export function restoreSilences(cuts: readonly Cut[] | undefined, splits: readonly number[] | undefined, prefix = SILENCE_CUT_PREFIX): { cuts: Cut[]; splits: number[] } {
  const all = normalizeCuts(cuts)
  const silence = all.filter((c) => c.id.startsWith(prefix))
  const kept = all.filter((c) => !c.id.startsWith(prefix))
  const edges = new Set(silence.flatMap((c) => [c.start, c.end]))
  const keptEdges = new Set(kept.flatMap((c) => [c.start, c.end]))
  return {
    cuts: kept,
    splits: (splits ?? []).filter((t) => !([...edges].some((e) => Math.abs(e - t) < 1e-6) && ![...keptEdges].some((e) => Math.abs(e - t) < 1e-6)))
  }
}

/** Removed silence: how many stretches and how many seconds. */
export function silenceSummary(cuts: readonly Cut[] | undefined): { count: number; seconds: number } {
  const silence = normalizeCuts(cuts).filter((c) => c.id.startsWith(SILENCE_CUT_PREFIX))
  return { count: silence.length, seconds: silence.reduce((sum, c) => sum + (c.end - c.start), 0) }
}

/** Width of one loudness window, in seconds. */
export const LEVEL_WINDOW_SEC = 0.02

/**
 * Accumulates decoded audio into per-window loudness. Feed it every sample in
 * any order; windows no sample reached read as silence.
 */
export class LevelMeter {
  private readonly sumSq: Float64Array
  private readonly count: Float64Array

  constructor(readonly durationSec: number, readonly windowSec = LEVEL_WINDOW_SEC) {
    const n = Math.max(0, Math.ceil(durationSec / windowSec))
    this.sumSq = new Float64Array(n)
    this.count = new Float64Array(n)
  }

  /** Interleaved samples starting at `timestamp` seconds. */
  add(interleaved: ArrayLike<number>, frames: number, channels: number, sampleRate: number, timestamp: number): void {
    if (!(sampleRate > 0) || channels <= 0) return
    const n = this.sumSq.length
    for (let f = 0; f < frames; f++) {
      const w = Math.floor((timestamp + f / sampleRate) / this.windowSec)
      if (w < 0 || w >= n) continue
      for (let c = 0; c < channels; c++) {
        const v = interleaved[f * channels + c]
        this.sumSq[w] += v * v
        this.count[w] += 1
      }
    }
  }

  levels(): Float32Array {
    const out = new Float32Array(this.sumSq.length)
    for (let i = 0; i < out.length; i++) {
      const mean = this.count[i] > 0 ? this.sumSq[i] / this.count[i] : 0
      out[i] = mean > 0 ? Math.max(FLOOR_DB, 10 * Math.log10(mean)) : FLOOR_DB
    }
    return out
  }
}
