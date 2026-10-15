/**
 * Captions: timed lines of text, transcribed locally and burned into the video.
 *
 * Cues are in source seconds, the same clock as trim, cuts and zoom, so a cue
 * inside a removed clip is skipped along with it and nothing needs retiming.
 * Transcription (main/captions.ts) runs whisper.cpp with the bundled English
 * model; nothing leaves the machine.
 */

/** Shown by the Captions panel, and the start of every packaged-build reason from main/captions.ts. */
export const CAPTIONS_NOT_INSTALLED = 'Offline captions are not installed on this build.'

/** Whether this build carries the speech engine and model; from main/captions.ts, shown by the Captions panel. */
export interface CaptionsStatus {
  /** Engine and model are both present, so Transcribe can run. */
  installed: boolean
  /** What is missing, fit to show; null when installed. */
  reason: string | null
}

/** One spoken word and when it was said, in source seconds. */
export interface CaptionWord {
  text: string
  start: number
  end: number
}

export interface CaptionCue {
  id: string
  start: number
  end: number
  text: string
  /** When each word was said, from the transcriber; absent on older or edited lines, which estimate it. */
  words?: CaptionWord[]
}

export type CaptionPosition = 'bottom' | 'top'

/**
 * How a caption is drawn.
 * - `box`: the line on a dark box (the original look).
 * - `karaoke`: the box, with each word lit as it is said.
 * - `bold`: large heavy capitals with an outline, the word being said in the highlight colour.
 * - `minimal`: plain white text with a soft shadow, no box.
 */
export type CaptionStyle = 'box' | 'karaoke' | 'bold' | 'minimal'
export const CAPTION_STYLES: readonly CaptionStyle[] = ['box', 'karaoke', 'bold', 'minimal']
export const DEFAULT_CAPTION_HIGHLIGHT = '#ffd84d'

export interface CaptionSettings {
  enabled: boolean
  cues: CaptionCue[]
  /** Multiplier on the base text size. */
  size: number
  position: CaptionPosition
  /** Absent on projects from before styles existed, which keeps them as `box`. */
  style?: CaptionStyle
  /** Colour of the word being said, a hex colour. */
  highlight?: string
  /**
   * Transcribe the microphone by itself the first time the editor opens this
   * take. Set on new takes whose starting look styles captions; cleared once
   * tried, whatever the outcome.
   */
  auto?: boolean
  /** The script the captions were last made from, kept so it can be edited and made again. */
  script?: string
  /** How that script was timed. */
  scriptTiming?: 'clicks' | 'even'
}

export const DEFAULT_CAPTIONS: CaptionSettings = { enabled: false, cues: [], size: 1, position: 'bottom' }
export const CAPTION_SIZE_RANGE = { min: 0.6, max: 1.8 } as const

/** Longest caption line whisper is asked for, in characters. */
export const CAPTION_LINE_CHARS = 42

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

function normalizeWords(value: unknown): CaptionWord[] | undefined {
  if (!Array.isArray(value)) return undefined
  const words = value.filter((w): w is CaptionWord => !!w && typeof w.text === 'string' && w.text.trim() !== '' && finite(w.start) && finite(w.end) && w.end >= w.start)
  return words.length ? words.map((w) => ({ text: w.text.trim(), start: Math.max(0, w.start), end: w.end })) : undefined
}

export function normalizeCaptions(value: unknown): CaptionSettings {
  const raw = (value ?? {}) as Partial<CaptionSettings>
  const cues = Array.isArray(raw.cues)
    ? raw.cues
        .filter((c): c is CaptionCue => !!c && finite(c.start) && finite(c.end) && c.end > c.start && typeof c.text === 'string')
        .map((c, i) => {
          const words = normalizeWords(c.words)
          return { id: typeof c.id === 'string' && c.id ? c.id : `cue-${i}`, start: Math.max(0, c.start), end: c.end, text: c.text, ...(words ? { words } : {}) }
        })
        .sort((a, b) => a.start - b.start)
    : []
  const size = finite(raw.size) ? Math.min(CAPTION_SIZE_RANGE.max, Math.max(CAPTION_SIZE_RANGE.min, raw.size)) : DEFAULT_CAPTIONS.size
  const style = CAPTION_STYLES.includes(raw.style as CaptionStyle) ? (raw.style as CaptionStyle) : undefined
  const highlight = typeof raw.highlight === 'string' && /^#[0-9a-f]{6}$/i.test(raw.highlight) ? raw.highlight : undefined
  return { enabled: raw.enabled === true, cues, size, position: raw.position === 'top' ? 'top' : 'bottom', ...(style ? { style } : {}), ...(highlight ? { highlight } : {}), ...(raw.auto === true ? { auto: true } : {}), ...(typeof raw.script === 'string' && raw.script ? { script: raw.script.slice(0, 20_000) } : {}), ...(raw.scriptTiming === 'clicks' || raw.scriptTiming === 'even' ? { scriptTiming: raw.scriptTiming } : {}) }
}

/**
 * Whisper marks what is not speech as a bracketed tag: [BLANK_AUDIO], [Music],
 * (keyboard clicking). Those are not captions.
 */
export function isNonSpeech(text: string): boolean {
  const t = text.trim()
  return t === '' || /^[[(][^\])]*[\])]$/.test(t)
}

/**
 * Words and their times from one segment's tokens in whisper-cli's `-ojf`
 * JSON. A token starting with a space begins a word; the pieces after it,
 * and punctuation, join it. Special tokens like [_BEG_] are skipped.
 */
export function wordsFromTokens(tokens: unknown): CaptionWord[] {
  if (!Array.isArray(tokens)) return []
  const words: CaptionWord[] = []
  for (const t of tokens) {
    const text = typeof t?.text === 'string' ? t.text : ''
    const from = t?.offsets?.from
    const to = t?.offsets?.to
    if (!text || text.trim().startsWith('[_') || !finite(from) || !finite(to)) continue
    const last = words.at(-1)
    const startsWord = /^\s/.test(text) || !last
    const piece = text.trim()
    if (!piece) continue
    if (startsWord && /[\p{L}\p{N}]/u.test(piece)) words.push({ text: piece, start: from / 1000, end: to / 1000 })
    else if (last) {
      last.text += piece
      last.end = Math.max(last.end, to / 1000)
    }
  }
  return words
}

/** Cues from whisper-cli's `-oj` or `-ojf` JSON; `-ojf` adds when each word was said. Unreadable input yields no cues. */
export function cuesFromWhisperJson(json: unknown): CaptionCue[] {
  const segments = (json as { transcription?: unknown })?.transcription
  if (!Array.isArray(segments)) return []
  const out: CaptionCue[] = []
  for (const seg of segments) {
    const from = seg?.offsets?.from
    const to = seg?.offsets?.to
    const text = typeof seg?.text === 'string' ? seg.text.trim() : ''
    if (!finite(from) || !finite(to) || to <= from || isNonSpeech(text)) continue
    const words = wordsFromTokens(seg?.tokens)
    // Only trust word times that spell the same words as the line.
    const matches = words.length > 0 && words.length === text.split(/\s+/).filter(Boolean).length
    out.push({ id: `cue-${from}`, start: from / 1000, end: to / 1000, text, ...(matches ? { words } : {}) })
  }
  return out
}

/**
 * When each word of `cue` is said: the transcriber's times when they still
 * match the text, otherwise spread across the line by word length, which is
 * how an edited line keeps a word-by-word highlight.
 */
export function cueWords(cue: CaptionCue): CaptionWord[] {
  const texts = cue.text.trim().split(/\s+/).filter(Boolean)
  if (cue.words && cue.words.length === texts.length) return cue.words.map((w, i) => ({ ...w, text: texts[i]! }))
  const weights = texts.map((w) => Math.max(1, w.replace(/[^\p{L}\p{N}]/gu, '').length) + 1)
  const total = weights.reduce((a, b) => a + b, 0) || 1
  const span = cue.end - cue.start
  let t = cue.start
  return texts.map((text, i) => {
    const d = (span * weights[i]!) / total
    const word = { text, start: t, end: t + d }
    t += d
    return word
  })
}

/**
 * `cue` without the words that were cut out of the video: a word that lies
 * wholly inside a cut (a removed "um", a removed clip) is left out of its
 * text and words. Lines without the transcriber's word times are returned as
 * they are, since an estimated time could drop a word that was kept.
 */
export function withoutCutWords(cue: CaptionCue, cuts: ReadonlyArray<{ start: number; end: number }> | undefined): CaptionCue {
  if (!cue.words || !cuts?.length) return cue
  const kept = cue.words.filter((w) => !cuts.some((c) => w.start >= c.start - 1e-6 && w.end <= c.end + 1e-6))
  if (kept.length === cue.words.length) return cue
  return { ...cue, words: kept, text: kept.map((w) => w.text).join(' ') }
}

/** Index of the word being said at `t`: the last one started, or -1 before the first. */
export function wordIndexAt(words: readonly CaptionWord[], t: number): number {
  let index = -1
  for (let i = 0; i < words.length; i++) if (words[i]!.start <= t) index = i
  return index
}

/** The cue showing at source time `t`, if any. */
export function captionAt(t: number, cues: readonly CaptionCue[]): CaptionCue | null {
  for (const c of cues) {
    if (t >= c.start && t < c.end) return c
    if (c.start > t) break
  }
  return null
}

/**
 * Break `text` into at most `maxLines` lines no wider than `maxWidth`, at word
 * boundaries. What does not fit ends the last line with an ellipsis rather
 * than running off the frame.
 */
export function wrapCaption(text: string, maxWidth: number, measure: (s: string) => number, maxLines = 2): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i]
    if (measure(next) <= maxWidth || !line) {
      line = next
      continue
    }
    lines.push(line)
    line = words[i]
    if (lines.length === maxLines) {
      let last = lines[maxLines - 1]
      while (last.includes(' ') && measure(`${last}…`) > maxWidth) last = last.slice(0, last.lastIndexOf(' '))
      lines[maxLines - 1] = `${last}…`
      return lines
    }
  }
  if (line) lines.push(line)
  return lines
}

/**
 * Replace one cue's text; an emptied cue is removed. Word times are kept only
 * while the word count is unchanged (a spelling fix), and estimated otherwise.
 */
export function editCue(cues: readonly CaptionCue[], id: string, text: string): CaptionCue[] {
  return cues.flatMap((c) => {
    if (c.id !== id) return [c]
    if (!text.trim()) return []
    const keep = c.words && c.words.length === text.trim().split(/\s+/).length
    const { words: _drop, ...rest } = c
    return [keep ? { ...c, text } : { ...rest, text }]
  })
}

/** `HH:MM:SS,mmm` as SubRip writes a time. */
export function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000))
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
}

/**
 * The cues as a SubRip (.srt) file, timed to the finished video. `toOutput`
 * maps a source time to the export's time (see outputTimeAt, which collapses a
 * cut to a point), so a cue keeps the part of it that survives and one that is
 * wholly cut is left out. A null from `toOutput` drops the cue too.
 */
export function cuesToSrt(cues: readonly CaptionCue[], toOutput: (sourceSec: number) => number | null): string {
  const blocks: string[] = []
  for (const cue of cues) {
    const start = toOutput(cue.start)
    const end = toOutput(cue.end)
    if (start === null || end === null || !(end > start) || !cue.text.trim()) continue
    blocks.push(`${blocks.length + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${cue.text.trim()}\n`)
  }
  return blocks.join('\n')
}
