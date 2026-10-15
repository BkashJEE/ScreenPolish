import { describe, expect, it } from 'vitest'
import { cueWords, cuesFromWhisperJson, cuesToSrt, editCue, normalizeCaptions, srtTime, wordIndexAt, wordsFromTokens, type CaptionCue } from './captions'
import { outputTimeAt, speedSpans } from './speed'

// The shape whisper-cli -ojf writes: special tokens, a space starting each word, pieces and punctuation joining it.
const tokens = [
  { text: '[_BEG_]', offsets: { from: 0, to: 0 } },
  { text: ' Open', offsets: { from: 0, to: 400 } },
  { text: ' the', offsets: { from: 400, to: 600 } },
  { text: ' ex', offsets: { from: 600, to: 900 } },
  { text: 'port', offsets: { from: 900, to: 1200 } },
  { text: ' menu', offsets: { from: 1300, to: 1700 } },
  { text: '.', offsets: { from: 1700, to: 1750 } },
  { text: '[_TT_88]', offsets: { from: 1750, to: 1750 } }
]

describe('word times from whisper', () => {
  it('joins word pieces and punctuation and skips special tokens', () => {
    expect(wordsFromTokens(tokens)).toEqual([
      { text: 'Open', start: 0, end: 0.4 },
      { text: 'the', start: 0.4, end: 0.6 },
      { text: 'export', start: 0.6, end: 1.2 },
      { text: 'menu.', start: 1.3, end: 1.75 }
    ])
  })

  it('keeps word times on a cue only when they spell the same words as its line', () => {
    const [cue] = cuesFromWhisperJson({ transcription: [{ offsets: { from: 0, to: 1800 }, text: ' Open the export menu.', tokens }] })
    expect(cue!.words).toHaveLength(4)
    const [plain] = cuesFromWhisperJson({ transcription: [{ offsets: { from: 0, to: 1800 }, text: ' Open the export menu.' }] })
    expect(plain!.words).toBeUndefined()
    const [mismatch] = cuesFromWhisperJson({ transcription: [{ offsets: { from: 0, to: 1800 }, text: ' Open it.', tokens }] })
    expect(mismatch!.words).toBeUndefined()
  })
})

describe('cueWords and wordIndexAt', () => {
  const cue: CaptionCue = { id: 'a', start: 10, end: 12, text: 'Open the export menu.' }

  it('estimates word times across the line when there are none, longer words taking longer', () => {
    const words = cueWords(cue)
    expect(words.map((w) => w.text)).toEqual(['Open', 'the', 'export', 'menu.'])
    expect(words[0]!.start).toBe(10)
    expect(words.at(-1)!.end).toBeCloseTo(12)
    expect(words[2]!.end - words[2]!.start).toBeGreaterThan(words[1]!.end - words[1]!.start)
  })

  it('uses the transcriber’s times when they still match, with the line’s spelling', () => {
    const timed = { ...cue, text: 'Open the Export menu.', words: [{ text: 'Open', start: 10, end: 10.3 }, { text: 'the', start: 10.3, end: 10.5 }, { text: 'export', start: 10.5, end: 11 }, { text: 'menu.', start: 11.2, end: 12 }] }
    const words = cueWords(timed)
    expect(words[2]).toEqual({ text: 'Export', start: 10.5, end: 11 })
  })

  it('names the last word started', () => {
    const words = cueWords(cue)
    expect(wordIndexAt(words, 9)).toBe(-1)
    expect(wordIndexAt(words, 10)).toBe(0)
    expect(wordIndexAt(words, 11.99)).toBe(3)
  })
})

describe('editing a line', () => {
  const cue: CaptionCue = { id: 'a', start: 0, end: 2, text: 'Open the menu', words: [{ text: 'Open', start: 0, end: 0.5 }, { text: 'the', start: 0.5, end: 1 }, { text: 'menu', start: 1, end: 2 }] }

  it('keeps word times through a spelling fix and drops them when words are added or removed', () => {
    expect(editCue([cue], 'a', 'Open the Menu')[0]!.words).toHaveLength(3)
    expect(editCue([cue], 'a', 'Now open the menu')[0]!.words).toBeUndefined()
  })

  it('survives a save and load, and refuses bad word data', () => {
    const loaded = normalizeCaptions({ enabled: true, cues: [cue], style: 'bold', highlight: '#00ff88' })
    expect(loaded.cues[0]!.words).toHaveLength(3)
    expect(loaded).toMatchObject({ style: 'bold', highlight: '#00ff88' })
    const bad = normalizeCaptions({ cues: [{ ...cue, words: [{ text: 'x' }] }], style: 'neon', highlight: 'red' })
    expect(bad.cues[0]!.words).toBeUndefined()
    expect(bad.style).toBeUndefined()
    expect(bad.highlight).toBeUndefined()
  })
})

describe('.srt', () => {
  it('writes SubRip times', () => {
    expect(srtTime(0)).toBe('00:00:00,000')
    expect(srtTime(3723.0456)).toBe('01:02:03,046')
  })

  it('times cues to the export: speed changes, cuts and an intro', () => {
    const cues: CaptionCue[] = [
      { id: '1', start: 1, end: 2, text: 'Before the speed-up' },
      { id: '2', start: 5, end: 6, text: 'Cut entirely' },
      { id: '3', start: 12, end: 14, text: 'After both' }
    ]
    // 0-10 s, with 4-8 s cut and 8-10 s at 2x: output 0-4 then 4-5 for the 2x part, then 10-20 at 1x.
    const spans = speedSpans(0, 20, [{ id: 'f', start: 8, end: 10, rate: 2 }], [{ id: 'c', start: 4, end: 8 }])
    const srt = cuesToSrt(cues, (t) => 3 + outputTimeAt(t, spans))
    expect(srt).toBe('1\n00:00:04,000 --> 00:00:05,000\nBefore the speed-up\n\n2\n00:00:10,000 --> 00:00:12,000\nAfter both\n')
  })
})
