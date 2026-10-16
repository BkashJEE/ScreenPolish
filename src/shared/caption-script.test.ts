import { describe, expect, it } from 'vitest'
import { MAX_CUE_SEC, SCRIPT_CHUNK_CHARS, scriptChunks, scriptCues, stepTimes } from './caption-script'

const range = { start: 0, end: 60 }

describe('a script cut into captions', () => {
  it('makes one caption per line and skips blank ones', () => {
    expect(scriptChunks('Open Footprint\n\n  Pick a profile  \nSee what is big')).toEqual(['Open Footprint', 'Pick a profile', 'See what is big'])
  })

  it('splits a long line at sentence ends, then between words', () => {
    const long = 'This is the first sentence of a long paragraph here. And this is the second one, which goes on for a while too. Short.'
    const chunks = scriptChunks(long)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(SCRIPT_CHUNK_CHARS)
    expect(chunks.join(' ')).toBe(long)
    expect(chunks[0]!.endsWith('.')).toBe(true)
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
    for (const c of scriptChunks(words)) expect(c.length).toBeLessThanOrEqual(SCRIPT_CHUNK_CHARS)
  })
})

describe('steps', () => {
  it('count presses close together once, and only inside the take', () => {
    expect(stepTimes([5, 5.4, 9, 30, 70], { start: 2, end: 60 })).toEqual([5, 9, 30])
  })
})

describe('captions from a script', () => {
  it('start each line at a click, with an opening line at the start when the first click is late', () => {
    const cues = scriptCues('Intro\nFirst\nSecond\nThird', range, 'clicks', [10, 20, 40])
    expect(cues.map((c) => c.text)).toEqual(['Intro', 'First', 'Second', 'Third'])
    expect(cues[0]!.start).toBe(0)
    expect(cues[1]!.start).toBeCloseTo(9.85)
    expect(cues[3]!.start).toBeCloseTo(39.85)
  })

  it('share a click between lines when there are more lines than clicks', () => {
    const cues = scriptCues('a\nb\nc\nd', range, 'clicks', [1, 31])
    expect(cues.map((c) => Math.round(c.start))).toEqual([1, 16, 31, 45])
  })

  it('use some of the clicks when there are more clicks than lines', () => {
    const cues = scriptCues('a\nb', range, 'clicks', [1, 10, 20, 30])
    expect(cues.map((c) => Math.round(c.start))).toEqual([1, 20])
  })

  it('spread evenly with no clicks, or when asked', () => {
    for (const cues of [scriptCues('a\nb\nc', range, 'clicks', []), scriptCues('a\nb\nc', range, 'even', [5, 6, 50])]) {
      expect(cues.map((c) => Math.round(c.start))).toEqual([0, 20, 40])
    }
  })

  it('never overlap, stay inside the take, and do not hang about', () => {
    const cues = scriptCues('one\ntwo words\nthree words here\nfour', { start: 3, end: 50 }, 'clicks', [4, 4.5, 12, 13, 30])
    for (const [i, c] of cues.entries()) {
      expect(c.end).toBeGreaterThan(c.start)
      expect(c.start).toBeGreaterThanOrEqual(3)
      expect(c.end).toBeLessThanOrEqual(50)
      expect(c.end - c.start).toBeLessThanOrEqual(MAX_CUE_SEC + 1e-9)
      if (i > 0) expect(c.start).toBeGreaterThanOrEqual(cues[i - 1]!.end)
    }
  })

  it('are empty for an empty script', () => {
    expect(scriptCues('  \n ', range, 'even')).toEqual([])
  })
})
