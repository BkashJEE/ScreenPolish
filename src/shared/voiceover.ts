import type { CaptionCue } from './captions'

/**
 * Voiceover: your voice recorded over a take after it was made.
 *
 * A clip sits on the take's OUTPUT clock (the seconds its export runs for),
 * not on the recording's own clock: a voice must not be sped up with a fast
 * stretch or chopped by a cut. The export mixes it in after every speed and
 * pitch step, and lowers the take's other sound while it plays.
 *
 * Each clip is a file in the take's folder (voiceover-<id>.m4a); the
 * recording itself is never touched. Recording over a clip replaces it.
 */

export interface VoiceoverClip {
  id: string
  /** File name in the take's folder. */
  file: string
  /** Output seconds where the clip starts. */
  atSec: number
  durationSec: number
  /** 0..2, 1 as recorded. */
  volume: number
}

export const VOICEOVER_FILE_RE = /^voiceover-[a-z0-9-]{4,64}\.m4a$/
export const MAX_VOICEOVER_CLIPS = 50

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

export function normalizeVoiceover(raw: unknown): VoiceoverClip[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const clips: VoiceoverClip[] = []
  for (const r of raw) {
    const c = (r ?? {}) as Partial<VoiceoverClip>
    if (typeof c.id !== 'string' || !c.id || seen.has(c.id)) continue
    if (typeof c.file !== 'string' || !VOICEOVER_FILE_RE.test(c.file)) continue
    if (!finite(c.atSec) || !finite(c.durationSec) || c.durationSec <= 0) continue
    seen.add(c.id)
    clips.push({ id: c.id, file: c.file, atSec: Math.max(0, c.atSec), durationSec: c.durationSec, volume: finite(c.volume) ? Math.min(2, Math.max(0, c.volume)) : 1 })
    if (clips.length >= MAX_VOICEOVER_CLIPS) break
  }
  return clips.sort((a, b) => a.atSec - b.atSec)
}

const overlaps = (a: VoiceoverClip, b: { atSec: number; durationSec: number }) => a.atSec < b.atSec + b.durationSec && b.atSec < a.atSec + a.durationSec

/** The clips with `clip` added; clips it overlaps are replaced, the way recording over tape does. */
export function addVoiceoverClip(clips: readonly VoiceoverClip[], clip: VoiceoverClip): { clips: VoiceoverClip[]; replaced: VoiceoverClip[] } {
  const replaced = clips.filter((c) => overlaps(c, clip))
  return { clips: [...clips.filter((c) => !overlaps(c, clip)), clip].sort((a, b) => a.atSec - b.atSec), replaced }
}

/** The clip playing at output second `t`, and how far into it. */
export function voiceAt(clips: readonly VoiceoverClip[], t: number): { clip: VoiceoverClip; localSec: number } | null {
  const clip = clips.find((c) => t >= c.atSec && t < c.atSec + c.durationSec)
  return clip ? { clip, localSec: t - clip.atSec } : null
}

/**
 * Captions transcribed from a voiceover file, moved onto the recording's
 * clock: `toSource` maps an output second to a source second, or null where
 * the output shows a card. Cues and words that land on a card are dropped.
 */
export function voiceoverCues(cues: readonly CaptionCue[], clip: VoiceoverClip, toSource: (outputSec: number) => number | null): CaptionCue[] {
  const out: CaptionCue[] = []
  for (const cue of cues) {
    const start = toSource(clip.atSec + cue.start)
    const end = toSource(clip.atSec + Math.min(cue.end, clip.durationSec))
    if (start === null || end === null || !(end > start)) continue
    const words = cue.words
      ?.map((w) => {
        const ws = toSource(clip.atSec + w.start)
        const we = toSource(clip.atSec + w.end)
        return ws === null || we === null ? null : { text: w.text, start: ws, end: Math.max(ws, we) }
      })
      .filter((w): w is NonNullable<typeof w> => w !== null)
    out.push({ id: `vo-${clip.id}-${out.length}`, start, end, text: cue.text, ...(words?.length ? { words } : {}) })
  }
  return out
}

/** `existing` with the cues inside source range [from, to] replaced by `fresh`. */
export function replaceCuesIn(existing: readonly CaptionCue[], from: number, to: number, fresh: readonly CaptionCue[]): CaptionCue[] {
  const kept = existing.filter((c) => c.end <= from || c.start >= to)
  return [...kept, ...fresh].sort((a, b) => a.start - b.start)
}

/**
 * ffmpeg arguments that lay voiceover files over a finished export: each
 * clip delayed to its place, the take's own sound lowered while a voice
 * plays (when `duck`), everything limited, the video copied untouched.
 * `hasAudio` is whether the export already has a sound track; without one
 * the voices alone become it, padded to `durationSec`.
 */
export function voiceoverMixArgs(
  video: string,
  voices: ReadonlyArray<{ path: string; atSec: number; volume: number }>,
  opts: { hasAudio: boolean; durationSec: number; duck: boolean },
  out: string
): string[] {
  if (voices.length === 0) throw new Error('No voiceover to mix')
  const parts: string[] = []
  voices.forEach((v, i) => {
    const ms = Math.max(0, Math.round(v.atSec * 1000))
    parts.push(`[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}:all=1,volume=${Math.min(2, Math.max(0, v.volume)).toFixed(3)}[v${i}]`)
  })
  const labels = voices.map((_, i) => `[v${i}]`).join('')
  const d = Math.max(0.1, opts.durationSec).toFixed(3)
  // Padded to the whole video: the ducking stops wherever its key ends, which would cut the take's sound off there.
  parts.push(`${voices.length > 1 ? `${labels}amix=inputs=${voices.length}:normalize=0:duration=longest` : '[v0]anull'},apad=whole_dur=${d},atrim=duration=${d}[vo]`)
  if (opts.hasAudio) {
    parts.push(`[0:a]aresample=48000,aformat=channel_layouts=stereo[base]`)
    if (opts.duck) {
      parts.push(`[vo]asplit=2[vmix][vkey]`)
      // The voice keys a compressor on everything else: about 12 dB down while talking, back up in the pauses.
      parts.push(`[base][vkey]sidechaincompress=threshold=0.02:ratio=6:attack=20:release=400[ducked]`)
      parts.push(`[ducked][vmix]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95[a]`)
    } else {
      parts.push(`[base][vo]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95[a]`)
    }
  } else {
    parts.push(`[vo]alimiter=limit=0.95[a]`)
  }
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', video,
    ...voices.flatMap((v) => ['-i', v.path]),
    '-filter_complex', parts.join(';'),
    '-map', '0:v:0', '-map', '[a]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
    out
  ]
}
